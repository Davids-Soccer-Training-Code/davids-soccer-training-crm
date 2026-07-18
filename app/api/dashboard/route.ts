import { query } from "@/lib/db";
import { jsonResponse, errorResponse } from "@/lib/api-helpers";
import { ensureStaffTables } from "@/app/api/staff/route";

function normalizeToUtcIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value).trim();
  if (!s) return null;
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/.test(s);
  const asUtc = hasTimezone ? s : `${s.replace(' ', 'T')}Z`;
  const d = new Date(asUtc);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
import {
  getTodayBoundsArizona,
  getDateBoundsArizona,
  getWeekStartArizona,
  getMonthStartArizona,
  getFutureDateArizona,
  nowInArizona,
} from "@/lib/timezone";
import { NextRequest } from "next/server";

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await ensureStaffTables();
    // Use Arizona timezone for all date calculations.
    const { start: todayStart, end: todayEnd } = getTodayBoundsArizona();
    const dayOffsetRaw = Number(request.nextUrl.searchParams.get("dayOffset") ?? "0");
    const dayOffset = Number.isFinite(dayOffsetRaw)
      ? Math.max(-30, Math.min(30, Math.trunc(dayOffsetRaw)))
      : 0;

    let selectedStart = todayStart;
    let selectedEnd = todayEnd;

    if (dayOffset !== 0) {
      const targetArizonaDate = nowInArizona();
      targetArizonaDate.setDate(targetArizonaDate.getDate() + dayOffset);
      const selectedBounds = getDateBoundsArizona(targetArizonaDate);
      selectedStart = selectedBounds.start;
      selectedEnd = selectedBounds.end;
    }

    // Selected-day phone calls.
    // For today, keep undated calls visible; for future days, only show dated calls in that day window.
    const callsResult = dayOffset === 0
      ? await query(
          `SELECT * FROM crm_parents
           WHERE phone_call_booked = true
           AND COALESCE(is_dead, false) = false
           AND (call_outcome IS NULL OR call_outcome NOT IN ('session_booked', 'uninterested'))
           AND (
             (call_date_time >= $1 AND call_date_time <= $2)
             OR call_date_time IS NULL
           )
           ORDER BY call_date_time NULLS LAST`,
          [selectedStart, selectedEnd]
        )
      : await query(
          `SELECT * FROM crm_parents
           WHERE phone_call_booked = true
           AND COALESCE(is_dead, false) = false
           AND (call_outcome IS NULL OR call_outcome NOT IN ('session_booked', 'uninterested'))
           AND call_date_time >= $1
           AND call_date_time <= $2
           ORDER BY call_date_time NULLS LAST`,
          [selectedStart, selectedEnd]
        );

    // Selected-day first sessions (exclude cancelled and completed)
    const firstSessionsResult = await query(
      `SELECT fs.*, p.name as parent_name,
        ARRAY_AGG(pl.name) FILTER (WHERE pl.name IS NOT NULL) as player_names,
        ARRAY_AGG(pl.id) FILTER (WHERE pl.id IS NOT NULL) as player_ids
       FROM crm_first_sessions fs
       JOIN crm_parents p ON p.id = fs.parent_id
       LEFT JOIN crm_first_session_players fsp ON fsp.first_session_id = fs.id
       LEFT JOIN crm_players pl ON pl.id = fsp.player_id
       WHERE fs.session_date >= $1 AND fs.session_date <= $2
       AND (fs.status IS NULL OR fs.status NOT IN ('cancelled', 'completed'))
       AND COALESCE(p.is_dead, false) = false
       GROUP BY fs.id, p.name
       ORDER BY fs.session_date`,
      [selectedStart, selectedEnd]
    );

    // Selected-day regular sessions (exclude cancelled and completed)
    const sessionsResult = await query(
      `SELECT s.*, p.name as parent_name, st.name as coach_name,
        ARRAY_AGG(pl.name) FILTER (WHERE pl.name IS NOT NULL) as player_names,
        ARRAY_AGG(pl.id) FILTER (WHERE pl.id IS NOT NULL) as player_ids
       FROM crm_sessions s
       JOIN crm_parents p ON p.id = s.parent_id
       LEFT JOIN crm_staff st ON st.id = s.coach_id
       LEFT JOIN crm_session_players sp ON sp.session_id = s.id
       LEFT JOIN crm_players pl ON pl.id = sp.player_id
       WHERE s.session_date >= $1 AND s.session_date <= $2
       AND (s.status IS NULL OR s.status NOT IN ('cancelled', 'completed'))
       AND COALESCE(p.is_dead, false) = false
       GROUP BY s.id, p.name, st.name
       ORDER BY s.session_date`,
      [selectedStart, selectedEnd]
    );

    // Selected-day pending reminders (for dashboard section) plus all unsent overdue carryover.
    // Include secondary parent in display name.
    // IMPORTANT: Use Arizona day boundaries, not due_at::date, because timestamps are stored
    // as UTC-coded values and date-only comparison can surface the wrong reminder type/day.
    const remindersResult = await query(
      `
      SELECT r.*,
        GREATEST(
          0,
          (
            DATE(($1::timestamptz AT TIME ZONE 'America/Phoenix'))
            - DATE((r.due_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Phoenix')
          )
        )::int as due_days_ago,
        p.dm_status as parent_dm_status,
        CASE
          WHEN r.reminder_category = 'session_reminder' THEN
            CASE
              WHEN r.session_id IS NOT NULL THEN (
                SELECT ARRAY_AGG(pl.name ORDER BY pl.created_at)
                FROM crm_session_players sp
                JOIN crm_players pl ON pl.id = sp.player_id
                WHERE sp.session_id = r.session_id
              )
              WHEN r.first_session_id IS NOT NULL THEN (
                SELECT ARRAY_AGG(pl.name ORDER BY pl.created_at)
                FROM crm_first_session_players fsp
                JOIN crm_players pl ON pl.id = fsp.player_id
                WHERE fsp.first_session_id = r.first_session_id
              )
              ELSE NULL
            END
          ELSE NULL
        END as player_names,
        CASE
          WHEN p.secondary_parent_name IS NOT NULL AND TRIM(COALESCE(p.secondary_parent_name, '')) != ''
          THEN p.name || ' and ' || p.secondary_parent_name
          ELSE p.name
        END as parent_name
      FROM crm_reminders r
      JOIN crm_parents p ON p.id = r.parent_id
      WHERE r.sent = false
        AND r.reminder_category = 'session_reminder'
        AND COALESCE(p.is_dead, false) = false
        AND r.due_at <= $2
      ORDER BY due_days_ago DESC, r.due_at ASC
    `,
      [selectedStart, selectedEnd]
    );

    // Stats - use Arizona time for week/month boundaries
    const weekStartStr = getWeekStartArizona();
    const monthStartStr = getMonthStartArizona();

    const statsResult = await query(
      `
      SELECT
        (SELECT COUNT(*) FROM crm_parents WHERE COALESCE(is_dead, false) = false) as total_contacts,
        (SELECT COUNT(*)
         FROM crm_first_sessions fs
         JOIN crm_parents p ON p.id = fs.parent_id
         WHERE fs.session_date >= $1
           AND fs.session_date <= $3
           AND (fs.status IS NULL OR fs.status NOT IN ('cancelled'))
           AND COALESCE(p.is_dead, false) = false)
        + (SELECT COUNT(*)
           FROM crm_sessions s
           JOIN crm_parents p ON p.id = s.parent_id
           WHERE s.session_date >= $1
             AND s.session_date <= $3
             AND (s.status IS NULL OR s.status NOT IN ('cancelled'))
             AND COALESCE(p.is_dead, false) = false) as sessions_this_week,
        (SELECT COALESCE(SUM(fs.price), 0)
         FROM crm_first_sessions fs
         JOIN crm_parents p ON p.id = fs.parent_id
         WHERE fs.session_date >= $2
           AND (fs.status IS NULL OR fs.status NOT IN ('cancelled'))
           AND COALESCE(p.is_dead, false) = false)
        + (SELECT COALESCE(SUM(s.price), 0)
           FROM crm_sessions s
           JOIN crm_parents p ON p.id = s.parent_id
           WHERE s.session_date >= $2
             AND (s.status IS NULL OR s.status NOT IN ('cancelled'))
             AND COALESCE(p.is_dead, false) = false) as revenue_this_month
    `,
      [weekStartStr, monthStartStr, todayEnd]
    );

    // Upcoming calls (next 3 months) - use Arizona time
    const futureDateStr = getFutureDateArizona(90);

    const upcomingCallsResult = await query(
      `SELECT * FROM crm_parents
       WHERE phone_call_booked = true
       AND COALESCE(is_dead, false) = false
       AND (call_outcome IS NULL OR call_outcome NOT IN ('session_booked', 'uninterested'))
       AND (
         (call_date_time >= $1 AND call_date_time <= $2)
         OR call_date_time IS NULL
       )
       ORDER BY call_date_time NULLS LAST`,
      [todayStart, futureDateStr]
    );

    // Upcoming first sessions (next 3 months, exclude cancelled and completed)
    const upcomingFirstSessionsResult = await query(
      `SELECT fs.*, p.name as parent_name,
        ARRAY_AGG(pl.name) FILTER (WHERE pl.name IS NOT NULL) as player_names,
        ARRAY_AGG(pl.id) FILTER (WHERE pl.id IS NOT NULL) as player_ids
       FROM crm_first_sessions fs
       JOIN crm_parents p ON p.id = fs.parent_id
       LEFT JOIN crm_first_session_players fsp ON fsp.first_session_id = fs.id
       LEFT JOIN crm_players pl ON pl.id = fsp.player_id
       WHERE fs.session_date >= $1 AND fs.session_date <= $2
       AND (fs.status IS NULL OR fs.status NOT IN ('cancelled', 'completed'))
       AND COALESCE(p.is_dead, false) = false
       GROUP BY fs.id, p.name
       ORDER BY fs.session_date`,
      [todayStart, futureDateStr]
    );

    // Upcoming regular sessions (next 3 months, exclude cancelled and completed)
    const upcomingSessionsResult = await query(
      `SELECT s.*, p.name as parent_name, st.name as coach_name,
        ARRAY_AGG(pl.name) FILTER (WHERE pl.name IS NOT NULL) as player_names,
        ARRAY_AGG(pl.id) FILTER (WHERE pl.id IS NOT NULL) as player_ids
       FROM crm_sessions s
       JOIN crm_parents p ON p.id = s.parent_id
       LEFT JOIN crm_staff st ON st.id = s.coach_id
       LEFT JOIN crm_session_players sp ON sp.session_id = s.id
       LEFT JOIN crm_players pl ON pl.id = sp.player_id
       WHERE s.session_date >= $1 AND s.session_date <= $2
       AND (s.status IS NULL OR s.status NOT IN ('cancelled', 'completed'))
       AND COALESCE(p.is_dead, false) = false
       GROUP BY s.id, p.name, st.name
       ORDER BY s.session_date`,
      [todayStart, futureDateStr]
    );

    const upcomingGroupSessionsResult = await query(
      `SELECT
        gs.*,
        COUNT(ps.id) FILTER (WHERE ps.has_paid = true)::int AS player_count,
        COUNT(ps.id) FILTER (WHERE COALESCE(ps.has_paid, false) = false)::int AS prospect_count
       FROM group_sessions gs
       LEFT JOIN player_signups ps ON ps.group_session_id = gs.id
       WHERE gs.session_date >= $1 AND gs.session_date <= $2
       GROUP BY gs.id
       ORDER BY gs.session_date`,
      [todayStart, futureDateStr]
    );

    // ALL reminders for calendar (next 3 months) — include secondary parent in display name
    const allRemindersResult = await query(
      `
      SELECT r.*,
        p.dm_status as parent_dm_status,
        CASE
          WHEN r.reminder_category = 'session_reminder' THEN
            CASE
              WHEN r.session_id IS NOT NULL THEN (
                SELECT ARRAY_AGG(pl.name ORDER BY pl.created_at)
                FROM crm_session_players sp
                JOIN crm_players pl ON pl.id = sp.player_id
                WHERE sp.session_id = r.session_id
              )
              WHEN r.first_session_id IS NOT NULL THEN (
                SELECT ARRAY_AGG(pl.name ORDER BY pl.created_at)
                FROM crm_first_session_players fsp
                JOIN crm_players pl ON pl.id = fsp.player_id
                WHERE fsp.first_session_id = r.first_session_id
              )
              ELSE NULL
            END
          ELSE NULL
        END as player_names,
        CASE
          WHEN p.secondary_parent_name IS NOT NULL AND TRIM(COALESCE(p.secondary_parent_name, '')) != ''
          THEN p.name || ' and ' || p.secondary_parent_name
          ELSE p.name
        END as parent_name
      FROM crm_reminders r
      JOIN crm_parents p ON p.id = r.parent_id
      WHERE r.sent = false
        AND r.reminder_category = 'session_reminder'
        AND COALESCE(p.is_dead, false) = false
        AND r.due_at >= $1
        AND r.due_at <= $2
      ORDER BY r.due_at ASC
    `,
      [todayStart, futureDateStr]
    );

    return jsonResponse({
      todays_calls: callsResult.rows,
      todays_first_sessions: firstSessionsResult.rows,
      todays_sessions: sessionsResult.rows,
      pending_reminders: remindersResult.rows,
      selected_day_offset: dayOffset,
      stats: statsResult.rows[0],
      // Calendar data
      upcomingCalls: upcomingCallsResult.rows,
      upcomingFirstSessions: upcomingFirstSessionsResult.rows,
      upcomingSessions: upcomingSessionsResult.rows,
      upcomingGroupSessions: upcomingGroupSessionsResult.rows.map((row: Record<string, unknown>) => ({
        ...row,
        session_date: normalizeToUtcIso(row.session_date) ?? row.session_date,
        session_date_end: normalizeToUtcIso(row.session_date_end),
      })),
      upcomingReminders: allRemindersResult.rows,
    });
  } catch (error) {
    console.error("Error fetching dashboard:", error);
    return errorResponse("Failed to fetch dashboard data");
  }
}
