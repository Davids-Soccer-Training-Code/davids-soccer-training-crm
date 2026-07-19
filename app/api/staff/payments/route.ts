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
type CoachSource = 'session' | 'package' | 'player';

interface WeekSession {
  id: number;
  kind: SessionKind;
  session_date: string;
  parent_name: string;
  player_names: string[];
  value: number;
  coach_source: CoachSource | null;
}

interface CoachGroup {
  coach_id: number | null;
  coach_name: string | null;
  is_owner: boolean;
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
    //
    // A session's coach is resolved with a fallback chain: the session's own
    // coach_id, else the coach on its package, else the coach the session's
    // players are assigned to (modal, tie-break by lowest staff id). This
    // matches how the app assigns coaches elsewhere, so a session that belongs
    // to a coach's package/players is attributed to them even if the session
    // row itself was never given an explicit coach.
    const regularResult = await query(
      `WITH player_coach AS (
         SELECT session_id, coach_id FROM (
           SELECT
             sp.session_id,
             pl.coach_id,
             ROW_NUMBER() OVER (
               PARTITION BY sp.session_id
               ORDER BY COUNT(*) DESC, pl.coach_id ASC
             ) AS rn
           FROM crm_session_players sp
           JOIN crm_players pl ON pl.id = sp.player_id
           WHERE pl.coach_id IS NOT NULL
           GROUP BY sp.session_id, pl.coach_id
         ) ranked
         WHERE rn = 1
       )
       SELECT
         s.id,
         s.session_date,
         s.coach_id AS own_coach_id,
         pkg.coach_id AS package_coach_id,
         pc.coach_id AS player_coach_id,
         COALESCE(s.coach_id, pkg.coach_id, pc.coach_id) AS coach_id,
         est.name AS coach_name,
         COALESCE(est.is_owner, false) AS coach_is_owner,
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
       LEFT JOIN crm_packages pkg ON pkg.id = s.package_id
       LEFT JOIN player_coach pc ON pc.session_id = s.id
       LEFT JOIN crm_staff est ON est.id = COALESCE(s.coach_id, pkg.coach_id, pc.coach_id)
       LEFT JOIN crm_session_players sp ON sp.session_id = s.id
       LEFT JOIN crm_players pl ON pl.id = sp.player_id
       WHERE s.session_date >= $1 AND s.session_date < $2
         AND COALESCE(s.cancelled, false) = false
         AND COALESCE(s.status, '') <> 'cancelled'
       GROUP BY s.id, s.coach_id, pkg.coach_id, pc.coach_id, est.name, est.is_owner, p.name, pkg.price, pkg.total_sessions
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
         COALESCE(st.is_owner, false) AS coach_is_owner,
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
      isOwner: boolean,
      session: WeekSession
    ) => {
      const key = coachId == null ? 'unassigned' : String(coachId);
      let group = groups.get(key);
      if (!group) {
        group = {
          coach_id: coachId,
          coach_name: coachName,
          is_owner: isOwner,
          sessions: [],
          total_value: 0,
          coach_payout: 0,
        };
        groups.set(key, group);
      }
      group.sessions.push(session);
      group.total_value += session.value;
    };

    for (const row of regularResult.rows) {
      const value = row.value == null ? 0 : Number(row.value);
      // Where the resolved coach came from, for a UI hint on inferred ones.
      let coachSource: CoachSource | null = null;
      if (row.coach_id != null) {
        if (row.own_coach_id != null) coachSource = 'session';
        else if (row.package_coach_id != null) coachSource = 'package';
        else coachSource = 'player';
      }
      addSession(row.coach_id, row.coach_name, row.coach_is_owner === true, {
        id: row.id,
        kind: row.is_package ? 'package' : 'session',
        session_date: row.session_date,
        parent_name: row.parent_name,
        player_names: Array.isArray(row.player_names) ? row.player_names : [],
        value,
        coach_source: coachSource,
      });
    }

    for (const row of firstResult.rows) {
      const value = row.value == null ? 0 : Number(row.value);
      addSession(row.coach_id, row.coach_name, row.coach_is_owner === true, {
        id: row.id,
        kind: 'first',
        session_date: row.session_date,
        parent_name: row.parent_name,
        player_names: [],
        value,
        coach_source: row.coach_id != null ? 'session' : null,
      });
    }

    // Payout rule: the owner takes no cut and keeps 100% of their own sessions;
    // every other coach is paid 50% of their session value. "Unassigned"
    // sessions aren't owed to anyone yet, so they carry no payout.
    const coaches = Array.from(groups.values())
      .map((group) => ({
        ...group,
        coach_payout:
          group.coach_id == null || group.is_owner
            ? 0
            : group.total_value * COACH_PAYOUT_RATE,
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
    // What must actually be paid out to the (non-owner) coaches.
    const owedToCoaches = coaches.reduce((sum, c) => sum + c.coach_payout, 0);
    // The owner keeps everything that isn't owed to another coach: their own
    // sessions at 100% plus the other 50% of every other coach's sessions.
    const ownerTake = grandTotalValue - owedToCoaches;

    return jsonResponse({
      week_start: startIso,
      week_end: endIso,
      payout_rate: COACH_PAYOUT_RATE,
      grand_total_value: grandTotalValue,
      owed_to_coaches: owedToCoaches,
      owner_take: ownerTake,
      coaches,
    });
  } catch (error) {
    console.error('Error computing coach payments:', error);
    return errorResponse('Failed to compute coach payments');
  }
}
