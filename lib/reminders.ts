import { query } from "@/lib/db";

function normalizeToUtcDate(dateValue: string | Date): Date {
  if (dateValue instanceof Date) {
    // `timestamp without time zone` values from pg are parsed into Date using the
    // runtime's local timezone. Rebuild using local date parts as UTC so behavior
    // is stable across local dev and Vercel (UTC).
    return new Date(
      Date.UTC(
        dateValue.getFullYear(),
        dateValue.getMonth(),
        dateValue.getDate(),
        dateValue.getHours(),
        dateValue.getMinutes(),
        dateValue.getSeconds(),
        dateValue.getMilliseconds()
      )
    );
  }

  // DB timestamp strings may not include timezone info. Treat those as UTC.
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/.test(dateValue);
  const normalized = hasTimezone
    ? dateValue
    : `${dateValue.replace(" ", "T")}Z`;

  return new Date(normalized);
}

export const SESSION_REMINDER_INTERVALS = [
  { type: "session_48h", offsetMinutes: -48 * 60 },
  { type: "session_24h", offsetMinutes: -24 * 60 },
  { type: "session_6h", offsetMinutes: -6 * 60 },
  { type: "session_start", offsetMinutes: 0 },
  { type: "coach_session_start", offsetMinutes: 0 },
  { type: "coach_session_plus_60m", offsetMinutes: 60 },
  { type: "parent_session_plus_120m", offsetMinutes: 180 },
] as const;

export const SESSION_REMINDER_TYPES = SESSION_REMINDER_INTERVALS.map(
  (interval) => interval.type
);

export type SessionReminderType = (typeof SESSION_REMINDER_INTERVALS)[number]["type"];

export async function createSessionReminders(
  parentId: number,
  sessionDate: string | Date,
  opts: { firstSessionId?: number; sessionId?: number; sessionEndDate?: string | Date | null }
) {
  // Session times are stored as UTC-coded values. Keep reminder offsets in UTC math
  // so 48h/24h/6h always align with the actual session instant in production.
  const sessionDateUtc = normalizeToUtcDate(sessionDate);
  const sessionEndDateRaw = opts.sessionEndDate
    ? normalizeToUtcDate(opts.sessionEndDate)
    : new Date(sessionDateUtc.getTime() + 60 * 60 * 1000);
  const sessionEndDateUtc =
    sessionEndDateRaw.getTime() > sessionDateUtc.getTime()
      ? sessionEndDateRaw
      : new Date(sessionDateUtc.getTime() + 60 * 60 * 1000);
  let createdCount = 0;

  for (const interval of SESSION_REMINDER_INTERVALS) {
    const anchorUtc =
      interval.type === "parent_session_plus_120m"
        ? sessionEndDateUtc
        : sessionDateUtc;
    const dueAtUtc = new Date(
      anchorUtc.getTime() + interval.offsetMinutes * 60 * 1000
    );

    const insertResult = await query(
      `INSERT INTO crm_reminders (parent_id, first_session_id, session_id, reminder_type, reminder_category, due_at)
       SELECT $1::int, $2::int, $3::int, $4::text, 'session_reminder', ($5::timestamptz AT TIME ZONE 'UTC')
       WHERE NOT EXISTS (
         SELECT 1
         FROM crm_reminders
       WHERE parent_id = $1::int
           AND first_session_id IS NOT DISTINCT FROM $2::int
           AND session_id IS NOT DISTINCT FROM $3::int
           AND reminder_type = $4::text
           AND reminder_category = 'session_reminder'
           AND due_at = ($5::timestamptz AT TIME ZONE 'UTC')
       )`,
      [
        parentId,
        opts.firstSessionId || null,
        opts.sessionId || null,
        interval.type,
        dueAtUtc.toISOString(),
      ]
    );

    createdCount += insertResult.rowCount || 0;
  }

  return createdCount;
}

export async function createFollowUpReminders(
  _parentId: number,
  _category: string,
  _opts?: {
    anchorDate?: string | Date;
    skipPastIntervals?: boolean;
    anchorTimezone?: "utc" | "arizona_local";
  }
) {
  void _parentId;
  void _category;
  void _opts;

  return 0;
}
