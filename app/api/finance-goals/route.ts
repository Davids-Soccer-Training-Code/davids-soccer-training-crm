import { query } from '@/lib/db';
import { jsonResponse, errorResponse } from '@/lib/api-helpers';
import { ARIZONA_TIMEZONE, nowInArizona } from '@/lib/timezone';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

export const dynamic = 'force-dynamic';

const WEEKLY_GOAL = 800;
const MONTHLY_GOAL = 3200;
const DAY_MS = 24 * 60 * 60 * 1000;
const TRACKING_START_WEEK = '2025-12-28';

type DaySource = 'packages' | 'sessions' | 'group_sessions';

interface DayRow {
  day_key: string;
  source: DaySource;
  amount: string | number;
}

interface PotentialDayRow {
  day_key: string;
  amount: string | number;
}

interface SessionListRow {
  id: number;
  session_type: 'first' | 'regular';
  session_date: string;
  location: string | null;
  price: string | number;
  was_paid: boolean;
  status: string | null;
  parent_name: string;
  player_names: string[] | null;
  is_active: boolean;
}

interface RevenueByYearRow {
  year_key: string;
  total: string | number;
}

function asNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function getWeekBoundsArizona(): { start: string; end: string } {
  const azNow = nowInArizona();
  const weekStartLocal = new Date(
    azNow.getFullYear(),
    azNow.getMonth(),
    azNow.getDate() - azNow.getDay(),
    0,
    0,
    0,
    0
  );
  const weekEndLocal = new Date(
    azNow.getFullYear(),
    azNow.getMonth(),
    azNow.getDate() - azNow.getDay() + 6,
    23,
    59,
    59,
    999
  );

  return {
    start: fromZonedTime(weekStartLocal, ARIZONA_TIMEZONE).toISOString(),
    end: fromZonedTime(weekEndLocal, ARIZONA_TIMEZONE).toISOString(),
  };
}

function getMonthBoundsArizona(): { start: string; end: string } {
  const azNow = nowInArizona();
  const monthStartLocal = new Date(azNow.getFullYear(), azNow.getMonth(), 1, 0, 0, 0, 0);
  const monthEndLocal = new Date(azNow.getFullYear(), azNow.getMonth() + 1, 0, 23, 59, 59, 999);

  return {
    start: fromZonedTime(monthStartLocal, ARIZONA_TIMEZONE).toISOString(),
    end: fromZonedTime(monthEndLocal, ARIZONA_TIMEZONE).toISOString(),
  };
}

function formatWeekRange(startIso: string, endIso: string): string {
  return `${formatInTimeZone(startIso, ARIZONA_TIMEZONE, 'MM/dd/yyyy')} - ${formatInTimeZone(endIso, ARIZONA_TIMEZONE, 'MM/dd/yyyy')}`;
}

function getTrackingStartWeekIsoArizona(): string {
  return fromZonedTime(`${TRACKING_START_WEEK}T00:00:00`, ARIZONA_TIMEZONE).toISOString();
}

async function hasGroupSessionPaymentsTables(): Promise<boolean> {
  const result = await query(`
    SELECT
      to_regclass('public.group_sessions') IS NOT NULL AS has_group_sessions,
      to_regclass('public.player_signups') IS NOT NULL AS has_player_signups,
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'player_signups'
          AND column_name = 'signup_price'
      ) AS has_signup_price,
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'player_signups'
          AND column_name = 'amount_paid'
      ) AS has_amount_paid
  `);

  const row = result.rows[0] as
    | {
        has_group_sessions?: boolean;
        has_player_signups?: boolean;
        has_signup_price?: boolean;
        has_amount_paid?: boolean;
      }
    | undefined;

  return Boolean(
    row?.has_group_sessions &&
      row?.has_player_signups &&
      (row?.has_signup_price || row?.has_amount_paid)
  );
}

const GROUP_SESSION_PAYMENTS_UNION_ALL = `
  UNION ALL
  SELECT
    COALESCE(ps.updated_at, ps.created_at) AS paid_at,
    COALESCE(ps.amount_paid, ps.signup_price)::numeric AS amount
  FROM player_signups ps
  WHERE ps.has_paid = true
    AND COALESCE(ps.amount_paid, ps.signup_price) IS NOT NULL
    AND COALESCE(ps.updated_at, ps.created_at) <= $1
`;

const GROUP_SESSION_PAYMENTS_UNION_FILTERED = `
  UNION ALL
  SELECT
    COALESCE(ps.updated_at, ps.created_at) AS paid_at,
    COALESCE(ps.amount_paid, ps.signup_price)::numeric AS amount
  FROM player_signups ps
  WHERE ps.has_paid = true
    AND COALESCE(ps.amount_paid, ps.signup_price) IS NOT NULL
    AND COALESCE(ps.updated_at, ps.created_at) >= $1
    AND COALESCE(ps.updated_at, ps.created_at) <= $2
    AND COALESCE(ps.updated_at, ps.created_at) <= $3
`;

const GROUP_SESSION_WEEK_BREAKDOWN_UNION = `
            UNION ALL
            SELECT
              COALESCE(ps.updated_at, ps.created_at) AS paid_at,
              COALESCE(ps.amount_paid, ps.signup_price)::numeric AS amount,
              'group_sessions'::text AS source
            FROM player_signups ps
            WHERE ps.has_paid = true
              AND COALESCE(ps.amount_paid, ps.signup_price) IS NOT NULL
              AND COALESCE(ps.updated_at, ps.created_at) >= $1
              AND COALESCE(ps.updated_at, ps.created_at) <= $2
              AND COALESCE(ps.updated_at, ps.created_at) <= $3
`;

const GROUP_SESSION_PAST_WEEKS_UNION = `
            UNION ALL
            SELECT
              COALESCE(ps.updated_at, ps.created_at) AS paid_at,
              COALESCE(ps.amount_paid, ps.signup_price)::numeric AS amount
            FROM player_signups ps
            WHERE ps.has_paid = true
              AND COALESCE(ps.amount_paid, ps.signup_price) IS NOT NULL
              AND COALESCE(ps.updated_at, ps.created_at) >= $1
              AND COALESCE(ps.updated_at, ps.created_at) < $2
`;

function buildPaymentsUnionAll(includeGroupSessions: boolean): string {
  return `
  SELECT created_at AS paid_at, amount::numeric AS amount
  FROM crm_package_payment_events
  WHERE amount > 0
    AND (notes IS NULL OR notes IN ('initial_package_amount', 'manual_payment', 'slider_top_up', 'package_payment'))
    AND created_at <= $1
  UNION ALL
  SELECT session_date AS paid_at, price::numeric AS amount
  FROM crm_first_sessions
  WHERE price IS NOT NULL
    AND session_date <= $1
    AND COALESCE(cancelled, false) = false
    AND (status IS NULL OR status NOT IN ('cancelled', 'no_show'))
  UNION ALL
  SELECT session_date AS paid_at, price::numeric AS amount
  FROM crm_sessions
  WHERE price IS NOT NULL
    AND session_date <= $1
    AND COALESCE(cancelled, false) = false
    AND (status IS NULL OR status NOT IN ('cancelled', 'no_show'))
  ${includeGroupSessions ? GROUP_SESSION_PAYMENTS_UNION_ALL : ''}
`;
}

function buildPaymentsUnionFiltered(includeGroupSessions: boolean): string {
  return `
  SELECT created_at AS paid_at, amount::numeric AS amount
  FROM crm_package_payment_events
  WHERE amount > 0
    AND (notes IS NULL OR notes IN ('initial_package_amount', 'manual_payment', 'slider_top_up', 'package_payment'))
    AND created_at >= $1
    AND created_at <= $2
    AND created_at <= $3
  UNION ALL
  SELECT session_date AS paid_at, price::numeric AS amount
  FROM crm_first_sessions
  WHERE price IS NOT NULL
    AND session_date >= $1
    AND session_date <= $2
    AND session_date <= $3
    AND COALESCE(cancelled, false) = false
    AND (status IS NULL OR status NOT IN ('cancelled', 'no_show'))
  UNION ALL
  SELECT session_date AS paid_at, price::numeric AS amount
  FROM crm_sessions
  WHERE price IS NOT NULL
    AND session_date >= $1
    AND session_date <= $2
    AND session_date <= $3
    AND COALESCE(cancelled, false) = false
    AND (status IS NULL OR status NOT IN ('cancelled', 'no_show'))
  ${includeGroupSessions ? GROUP_SESSION_PAYMENTS_UNION_FILTERED : ''}
`;
}

const ALL_SESSIONS_WITH_DETAILS = `
  SELECT
    fs.id,
    'first'::text AS session_type,
    fs.session_date,
    fs.location,
    fs.price::numeric AS price,
    fs.was_paid,
    fs.status,
    p.name AS parent_name,
    ARRAY_AGG(pl.name) FILTER (WHERE pl.name IS NOT NULL) AS player_names,
    (
      COALESCE(fs.cancelled, false) = false
      AND (fs.status IS NULL OR fs.status NOT IN ('cancelled', 'no_show'))
    ) AS is_active
  FROM crm_first_sessions fs
  JOIN crm_parents p ON p.id = fs.parent_id
  LEFT JOIN crm_first_session_players fsp ON fsp.first_session_id = fs.id
  LEFT JOIN crm_players pl ON pl.id = fsp.player_id
  WHERE fs.price IS NOT NULL
  GROUP BY fs.id, p.name

  UNION ALL

  SELECT
    s.id,
    'regular'::text AS session_type,
    s.session_date,
    s.location,
    s.price::numeric AS price,
    s.was_paid,
    s.status,
    p.name AS parent_name,
    ARRAY_AGG(pl.name) FILTER (WHERE pl.name IS NOT NULL) AS player_names,
    (
      COALESCE(s.cancelled, false) = false
      AND (s.status IS NULL OR s.status NOT IN ('cancelled', 'no_show'))
    ) AS is_active
  FROM crm_sessions s
  JOIN crm_parents p ON p.id = s.parent_id
  LEFT JOIN crm_session_players sp ON sp.session_id = s.id
  LEFT JOIN crm_players pl ON pl.id = sp.player_id
  WHERE s.price IS NOT NULL
  GROUP BY s.id, p.name
`;

export async function GET() {
  try {
    const weekBounds = getWeekBoundsArizona();
    const monthBounds = getMonthBoundsArizona();
    const nowIso = new Date().toISOString();
    const includeGroupSessions = await hasGroupSessionPaymentsTables();
    const paymentsUnionAll = buildPaymentsUnionAll(includeGroupSessions);
    const paymentsUnionFiltered = buildPaymentsUnionFiltered(includeGroupSessions);

    const [
      weekBreakdownResult,
      weekPotentialSessionsResult,
      pastWeeksResult,
      monthTotalResult,
      overallTotalResult,
      yearTotalsResult,
      pastSessionsResult,
      upcomingSessionsResult,
    ] = await Promise.all([
      query(
        `
          SELECT
            TO_CHAR(((paid_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Phoenix')::date, 'YYYY-MM-DD') AS day_key,
            source,
            COALESCE(SUM(amount), 0) AS amount
          FROM (
            SELECT created_at AS paid_at, amount::numeric AS amount, 'packages'::text AS source
            FROM crm_package_payment_events
            WHERE amount > 0
              AND (notes IS NULL OR notes IN ('initial_package_amount', 'manual_payment', 'slider_top_up', 'package_payment'))
              AND created_at >= $1
              AND created_at <= $2
              AND created_at <= $3
            UNION ALL
            SELECT session_date AS paid_at, price::numeric AS amount, 'sessions'::text AS source
            FROM crm_first_sessions
            WHERE price IS NOT NULL
              AND session_date >= $1
              AND session_date <= $2
              AND session_date <= $3
              AND COALESCE(cancelled, false) = false
              AND (status IS NULL OR status NOT IN ('cancelled', 'no_show'))
            UNION ALL
            SELECT session_date AS paid_at, price::numeric AS amount, 'sessions'::text AS source
            FROM crm_sessions
            WHERE price IS NOT NULL
              AND session_date >= $1
              AND session_date <= $2
              AND session_date <= $3
              AND COALESCE(cancelled, false) = false
              AND (status IS NULL OR status NOT IN ('cancelled', 'no_show'))
            ${includeGroupSessions ? GROUP_SESSION_WEEK_BREAKDOWN_UNION : ''}
          ) payments
          GROUP BY day_key, source
          ORDER BY day_key ASC
        `,
        [weekBounds.start, weekBounds.end, nowIso]
      ),
      query(
        `
          SELECT
            TO_CHAR(((session_date AT TIME ZONE 'UTC') AT TIME ZONE 'America/Phoenix')::date, 'YYYY-MM-DD') AS day_key,
            COALESCE(SUM(price), 0) AS amount
          FROM (
            SELECT fs.session_date, fs.price::numeric AS price
            FROM crm_first_sessions fs
            WHERE fs.price IS NOT NULL
              AND fs.session_date >= $1
              AND fs.session_date <= $2
              AND fs.session_date > $3
              AND COALESCE(fs.cancelled, false) = false
              AND (fs.status IS NULL OR fs.status NOT IN ('cancelled', 'no_show'))
            UNION ALL
            SELECT s.session_date, s.price::numeric AS price
            FROM crm_sessions s
            WHERE s.price IS NOT NULL
              AND s.session_date >= $1
              AND s.session_date <= $2
              AND s.session_date > $3
              AND COALESCE(s.cancelled, false) = false
              AND (s.status IS NULL OR s.status NOT IN ('cancelled', 'no_show'))
          ) possible_sessions
          GROUP BY day_key
          ORDER BY day_key ASC
        `,
        [weekBounds.start, weekBounds.end, nowIso]
      ),
      query(
        `
          WITH payments AS (
            SELECT created_at AS paid_at, amount::numeric AS amount
            FROM crm_package_payment_events
            WHERE amount > 0
              AND (notes IS NULL OR notes IN ('initial_package_amount', 'manual_payment', 'slider_top_up', 'package_payment'))
              AND created_at >= $1
              AND created_at < $2
            UNION ALL
            SELECT session_date AS paid_at, price::numeric AS amount
            FROM crm_first_sessions
            WHERE price IS NOT NULL
              AND session_date >= $1
              AND session_date < $2
              AND COALESCE(cancelled, false) = false
              AND (status IS NULL OR status NOT IN ('cancelled', 'no_show'))
            UNION ALL
            SELECT session_date AS paid_at, price::numeric AS amount
            FROM crm_sessions
            WHERE price IS NOT NULL
              AND session_date >= $1
              AND session_date < $2
              AND COALESCE(cancelled, false) = false
              AND (status IS NULL OR status NOT IN ('cancelled', 'no_show'))
            ${includeGroupSessions ? GROUP_SESSION_PAST_WEEKS_UNION : ''}
          ),
          localized AS (
            SELECT
              (((paid_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Phoenix')::date) AS local_day,
              amount
            FROM payments
          )
          SELECT
            TO_CHAR((local_day - EXTRACT(DOW FROM local_day)::int), 'YYYY-MM-DD') AS week_key,
            COALESCE(SUM(amount), 0) AS total
          FROM localized
          GROUP BY week_key
          ORDER BY week_key DESC
        `,
        [
          getTrackingStartWeekIsoArizona(),
          weekBounds.start,
        ]
      ),
      query(
        `
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM (${paymentsUnionFiltered}) AS payments
      `,
        [monthBounds.start, monthBounds.end, nowIso]
      ),
      query(
        `
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM (${paymentsUnionAll}) AS payments
      `,
        [nowIso]
      ),
      query(
        `
          SELECT
            TO_CHAR(((paid_at AT TIME ZONE 'UTC') AT TIME ZONE 'America/Phoenix')::date, 'YYYY') AS year_key,
            COALESCE(SUM(amount), 0) AS total
          FROM (${paymentsUnionAll}) AS payments
          GROUP BY year_key
          ORDER BY year_key ASC
        `,
        [nowIso]
      ),
      query(
        `
          WITH all_sessions AS (${ALL_SESSIONS_WITH_DETAILS})
          SELECT *
          FROM all_sessions
          WHERE is_active = true
            AND session_date <= $1
          ORDER BY session_date DESC
          LIMIT 50
        `,
        [nowIso]
      ),
      query(
        `
          WITH all_sessions AS (${ALL_SESSIONS_WITH_DETAILS})
          SELECT *
          FROM all_sessions
          WHERE is_active = true
            AND session_date > $1
          ORDER BY session_date ASC
          LIMIT 50
        `,
        [nowIso]
      ),
    ]);

    const weekStartDate = new Date(weekBounds.start);
    const dayMap: Record<
      string,
      {
        day_key: string;
        day_name: string;
        day_short: string;
        date_label: string;
        packages: number;
        sessions: number;
        group_sessions: number;
        sessions_possible: number;
        total: number;
      }
    > = {};

    for (let i = 0; i < 7; i += 1) {
      const dayDate = new Date(weekStartDate.getTime() + i * DAY_MS);
      const dayKey = formatInTimeZone(dayDate, ARIZONA_TIMEZONE, 'yyyy-MM-dd');
      dayMap[dayKey] = {
        day_key: dayKey,
        day_name: formatInTimeZone(dayDate, ARIZONA_TIMEZONE, 'EEEE'),
        day_short: formatInTimeZone(dayDate, ARIZONA_TIMEZONE, 'EEE'),
        date_label: formatInTimeZone(dayDate, ARIZONA_TIMEZONE, 'MM/dd'),
        packages: 0,
        sessions: 0,
        group_sessions: 0,
        sessions_possible: 0,
        total: 0,
      };
    }

    for (const row of weekBreakdownResult.rows as DayRow[]) {
      const day = dayMap[row.day_key];
      if (!day) continue;

      const amount = asNumber(row.amount);
      if (row.source === 'packages') {
        day.packages += amount;
      } else if (row.source === 'group_sessions') {
        day.group_sessions += amount;
      } else {
        day.sessions += amount;
      }
      day.total += amount;
    }

    for (const row of weekPotentialSessionsResult.rows as PotentialDayRow[]) {
      const day = dayMap[row.day_key];
      if (!day) continue;
      day.sessions_possible += asNumber(row.amount);
    }

    const days = Object.values(dayMap).map((day) => ({
      ...day,
      packages: round2(day.packages),
      sessions: round2(day.sessions),
      group_sessions: round2(day.group_sessions),
      sessions_possible: round2(day.sessions_possible),
      total: round2(day.total),
    }));

    const weekTotal = round2(days.reduce((sum, day) => sum + day.total, 0));
    const weekPotentialSessionsTotal = round2(
      days.reduce((sum, day) => sum + day.sessions_possible, 0)
    );
    const weekProjectedIfNoCancel = round2(weekTotal + weekPotentialSessionsTotal);
    const monthTotal = round2(asNumber(monthTotalResult.rows[0]?.total));
    const overallTotal = round2(asNumber(overallTotalResult.rows[0]?.total));
    const revenueByYear = (yearTotalsResult.rows as RevenueByYearRow[]).map((row) => ({
      year: Number(row.year_key),
      total: round2(asNumber(row.total)),
    }));
    const currentYear = Number(
      formatInTimeZone(new Date(), ARIZONA_TIMEZONE, 'yyyy')
    );

    const weekPct = WEEKLY_GOAL > 0 ? (weekTotal / WEEKLY_GOAL) * 100 : 0;
    const weekProjectedPct =
      WEEKLY_GOAL > 0 ? (weekProjectedIfNoCancel / WEEKLY_GOAL) * 100 : 0;
    const monthPct = MONTHLY_GOAL > 0 ? (monthTotal / MONTHLY_GOAL) * 100 : 0;

    const trackingStartWeekIso = getTrackingStartWeekIsoArizona();
    const pastWeeksMap = new Map<string, number>();
    for (const row of pastWeeksResult.rows as Array<{ week_key: string; total: string | number }>) {
      pastWeeksMap.set(row.week_key, round2(asNumber(row.total)));
    }

    const trackingStartDate = new Date(trackingStartWeekIso);
    const currentWeekStartDate = new Date(weekBounds.start);
    const pastWeeksCount = Math.max(
      0,
      Math.floor((currentWeekStartDate.getTime() - trackingStartDate.getTime()) / (7 * DAY_MS))
    );
    const pastWeeks = Array.from({ length: pastWeeksCount }, (_, idx) => {
      const weekStartDate = new Date(trackingStartDate.getTime() + idx * 7 * DAY_MS);
      const weekEndDate = new Date(weekStartDate.getTime() + 6 * DAY_MS + (DAY_MS - 1));
      const weekKey = formatInTimeZone(weekStartDate, ARIZONA_TIMEZONE, 'yyyy-MM-dd');
      const total = round2(pastWeeksMap.get(weekKey) ?? 0);
      const pct = WEEKLY_GOAL > 0 ? (total / WEEKLY_GOAL) * 100 : 0;
      return {
        week_number: idx + 1,
        week_start: weekStartDate.toISOString(),
        week_end: weekEndDate.toISOString(),
        range_label: formatWeekRange(weekStartDate.toISOString(), weekEndDate.toISOString()),
        total,
        percentage: round2(pct),
        over_goal_percentage: round2(Math.max(0, pct - 100)),
        met_goal: total >= WEEKLY_GOAL,
      };
    });

    const pastSessions = (pastSessionsResult.rows as SessionListRow[]).map((row) => ({
      ...row,
      price: round2(asNumber(row.price)),
      player_names: row.player_names || [],
    }));

    const upcomingSessions = (upcomingSessionsResult.rows as SessionListRow[]).map((row) => ({
      ...row,
      price: round2(asNumber(row.price)),
      player_names: row.player_names || [],
    }));

    const sessionsHappenedTotal = round2(
      pastSessions.reduce((sum, session) => sum + asNumber(session.price), 0)
    );
    const sessionsPotentialTotal = round2(
      upcomingSessions.reduce((sum, session) => sum + asNumber(session.price), 0)
    );

    return jsonResponse({
      goals: {
        weekly: WEEKLY_GOAL,
        monthly: MONTHLY_GOAL,
      },
      week: {
        start: weekBounds.start,
        end: weekBounds.end,
        range_label: formatWeekRange(weekBounds.start, weekBounds.end),
        days_counted_label: 'Sunday through Saturday',
        total: weekTotal,
        percentage: round2(weekPct),
        over_goal_percentage: round2(Math.max(0, weekPct - 100)),
        potential_sessions_total: weekPotentialSessionsTotal,
        projected_total_if_no_cancel: weekProjectedIfNoCancel,
        projected_percentage_if_no_cancel: round2(weekProjectedPct),
        projected_over_goal_percentage_if_no_cancel: round2(
          Math.max(0, weekProjectedPct - 100)
        ),
        days,
      },
      month: {
        start: monthBounds.start,
        end: monthBounds.end,
        range_label: formatWeekRange(monthBounds.start, monthBounds.end),
        total: monthTotal,
        percentage: round2(monthPct),
        over_goal_percentage: round2(Math.max(0, monthPct - 100)),
      },
      overall: {
        total: overallTotal,
      },
      years: {
        current: currentYear,
        totals: revenueByYear,
      },
      sessions: {
        happened: {
          count: pastSessions.length,
          total: sessionsHappenedTotal,
          items: pastSessions,
        },
        potential: {
          count: upcomingSessions.length,
          total: sessionsPotentialTotal,
          items: upcomingSessions,
        },
      },
      history: {
        past_weeks: pastWeeks,
      },
    });
  } catch (error) {
    console.error('Error fetching finance goals:', error);
    return errorResponse('Failed to fetch finance goals');
  }
}
