import { query } from '@/lib/db';
import { jsonResponse, errorResponse } from '@/lib/api-helpers';
import { ensureStaffTables } from '@/app/api/staff/route';
import { ensureSessionCalendarColumns } from '@/lib/session-calendar-fields';
import { ensureFirstSessionCalendarColumns } from '@/lib/first-session-calendar-fields';
import { parseDateAsArizona } from '@/lib/timezone';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

const COACH_PAYOUT_RATE = 0.5;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

type SessionKind = 'first' | 'package' | 'session';

interface WeekSession {
  id: number;
  kind: SessionKind;
  session_date: string;
  parent_name: string;
  player_names: string[];
  value: number;
}

interface CoachGroup {
  coach_id: number | null;
  coach_name: string | null;
  sessions: WeekSession[];
  total_value: number;
  coach_payout: number;
}

// Validate a YYYY-MM-DD string; defaults to null when malformed.
function isValidDateString(value: string | null): value is string {
  return !!value && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export async function GET(request: NextRequest) {
  try {
    await ensureStaffTables();
    await ensureSessionCalendarColumns();
    await ensureFirstSessionCalendarColumns();

    const weekStartParam = request.nextUrl.searchParams.get('week_start');
    if (!isValidDateString(weekStartParam)) {
      return errorResponse('week_start query param (YYYY-MM-DD) is required', 400);
    }

    // Arizona has no DST, so adding 7 * 24h to the week-start midnight lands
    // cleanly on the next Monday midnight.
    const startIso = parseDateAsArizona(weekStartParam);
    const endIso = new Date(new Date(startIso).getTime() + WEEK_MS).toISOString();

    // Regular + package sessions. Package sessions are valued at the package's
    // per-session rate (price / total_sessions) rather than their own price.
    const regularResult = await query(
      `SELECT
         s.id,
         s.session_date,
         s.coach_id,
         st.name AS coach_name,
         p.name AS parent_name,
         (s.package_id IS NOT NULL) AS is_package,
         CASE
           WHEN s.package_id IS NOT NULL
             THEN pkg.price::numeric / NULLIF(pkg.total_sessions, 0)
           ELSE s.price
         END AS value,
         ARRAY_AGG(pl.name) FILTER (WHERE pl.name IS NOT NULL) AS player_names
       FROM crm_sessions s
       JOIN crm_parents p ON p.id = s.parent_id
       LEFT JOIN crm_staff st ON st.id = s.coach_id
       LEFT JOIN crm_packages pkg ON pkg.id = s.package_id
       LEFT JOIN crm_session_players sp ON sp.session_id = s.id
       LEFT JOIN crm_players pl ON pl.id = sp.player_id
       WHERE s.session_date >= $1 AND s.session_date < $2
         AND COALESCE(s.cancelled, false) = false
         AND COALESCE(s.status, '') <> 'cancelled'
       GROUP BY s.id, st.name, p.name, pkg.price, pkg.total_sessions
       ORDER BY s.session_date`,
      [startIso, endIso]
    );

    // First (trial) sessions, valued at their own price.
    const firstResult = await query(
      `SELECT
         fs.id,
         fs.session_date,
         fs.coach_id,
         st.name AS coach_name,
         p.name AS parent_name,
         fs.price AS value
       FROM crm_first_sessions fs
       JOIN crm_parents p ON p.id = fs.parent_id
       LEFT JOIN crm_staff st ON st.id = fs.coach_id
       WHERE fs.session_date >= $1 AND fs.session_date < $2
         AND COALESCE(fs.cancelled, false) = false
         AND COALESCE(fs.status, '') <> 'cancelled'
       ORDER BY fs.session_date`,
      [startIso, endIso]
    );

    const groups = new Map<string, CoachGroup>();

    const addSession = (
      coachId: number | null,
      coachName: string | null,
      session: WeekSession
    ) => {
      const key = coachId == null ? 'unassigned' : String(coachId);
      let group = groups.get(key);
      if (!group) {
        group = {
          coach_id: coachId,
          coach_name: coachName,
          sessions: [],
          total_value: 0,
          coach_payout: 0,
        };
        groups.set(key, group);
      }
      group.sessions.push(session);
      group.total_value += session.value;
      group.coach_payout = group.total_value * COACH_PAYOUT_RATE;
    };

    for (const row of regularResult.rows) {
      const value = row.value == null ? 0 : Number(row.value);
      addSession(row.coach_id, row.coach_name, {
        id: row.id,
        kind: row.is_package ? 'package' : 'session',
        session_date: row.session_date,
        parent_name: row.parent_name,
        player_names: Array.isArray(row.player_names) ? row.player_names : [],
        value,
      });
    }

    for (const row of firstResult.rows) {
      const value = row.value == null ? 0 : Number(row.value);
      addSession(row.coach_id, row.coach_name, {
        id: row.id,
        kind: 'first',
        session_date: row.session_date,
        parent_name: row.parent_name,
        player_names: [],
        value,
      });
    }

    // Sort each coach's sessions by date, and order coaches by name with the
    // unassigned bucket last.
    const coaches = Array.from(groups.values())
      .map((group) => ({
        ...group,
        sessions: group.sessions.sort(
          (a, b) => new Date(a.session_date).getTime() - new Date(b.session_date).getTime()
        ),
      }))
      .sort((a, b) => {
        if (a.coach_id == null) return 1;
        if (b.coach_id == null) return -1;
        return (a.coach_name || '').localeCompare(b.coach_name || '');
      });

    const grandTotalValue = coaches.reduce((sum, c) => sum + c.total_value, 0);
    const grandTotalPayout = grandTotalValue * COACH_PAYOUT_RATE;

    return jsonResponse({
      week_start: startIso,
      week_end: endIso,
      payout_rate: COACH_PAYOUT_RATE,
      grand_total_value: grandTotalValue,
      grand_total_payout: grandTotalPayout,
      coaches,
    });
  } catch (error) {
    console.error('Error computing coach payments:', error);
    return errorResponse('Failed to compute coach payments');
  }
}
