import { query } from "@/lib/db";
import { errorResponse, jsonResponse } from "@/lib/api-helpers";
import {
  ensureAutoRemindersSchema,
  getSessionReminderDefaultsMap,
  ReminderDefaultRow,
} from "@/lib/auto-reminders";
import { formatArizonaDateTime, getDateBoundsArizona } from "@/lib/timezone";
import {
  getCoachPhoneNumber,
  normalizeUsPhoneNumber,
  sendSmsViaTwilio,
} from "@/lib/twilio";
import { formatInTimeZone } from "date-fns-tz";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = "iad1";

const MESSAGE_PREFIX = "Davids Soccer Training. DO NOT REPLY";
const MESSAGE_SUFFIX =
  "For any questions, reach out to Coach David at 720 612 2979.";
const GOOGLE_REVIEW_URL = "https://g.page/r/CbrmGhQt_77aEAI/review";

interface DueReminderRow {
  id: number;
  parent_id: number;
  session_id: number | null;
  first_session_id: number | null;
  reminder_type: string;
  due_at: string | Date;
  custom_message: string | null;
  parent_name: string;
  secondary_parent_name: string | null;
  parent_phone: string | null;
  session_date: string | Date | null;
  primary_crm_player_id: number | null;
  player_names: string[] | null;
  total_sessions_through_current: number | null;
}

interface PreparedMessage {
  to: string;
  body: string;
}

interface ReminderProcessingOptions {
  lowerBoundIso: string;
  upperBoundIso: string;
  dryRun: boolean;
  markSent: boolean;
  overrideTo: string | null;
  parentId: number | null;
  sessionId: number | null;
  firstSessionId: number | null;
  reminderTypes: string[];
}

interface ReminderStats {
  fetched: number;
  sent: number;
  skipped: number;
  failed: number;
  previewed: number;
  preview: Array<{
    id: number;
    reminderType: string;
    dueAt: string;
    to: string;
  }>;
}

interface AppReminderContext {
  appPlayerId: string;
  latestSessionId: string | null;
  latestFeedbackId: string | null;
  latestFeedbackTitle: string | null;
  latestFeedbackBlurb: string | null;
}

interface CustomScheduledMessageRow {
  id: number;
  parent_id: number;
  title: string | null;
  message_content: string;
  scheduled_for: string | Date;
  parent_name: string;
  secondary_parent_name: string | null;
  parent_phone: string | null;
}

interface CustomMessageStats {
  fetched: number;
  sent: number;
  skipped: number;
  failed: number;
  previewed: number;
  preview: Array<{
    id: number;
    dueAt: string;
    to: string;
  }>;
}

function normalizeUtcDate(dateValue: string | Date): Date {
  if (dateValue instanceof Date) {
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

  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/.test(dateValue);
  const normalized = hasTimezone
    ? dateValue
    : `${dateValue.replace(" ", "T")}Z`;

  return new Date(normalized);
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1)}...`;
}

function toPlainTextFromMarkdown(value: string): string {
  return value
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]*\)/g, "$1")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[*_~>#-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function renderTemplate(
  template: string,
  variables: Record<string, string>
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_full, key: string) => {
    return Object.prototype.hasOwnProperty.call(variables, key)
      ? variables[key] || ""
      : "";
  });
}

function normalizeTemplateOutput(value: string): string {
  return value
    .split("\n")
    .map((line) => compactWhitespace(line))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function wrapMessage(coreMessage: string): string {
  return `${MESSAGE_PREFIX}\n${compactWhitespace(coreMessage)}\n${MESSAGE_SUFFIX}`;
}

function wrapMessageLines(lines: string[]): string {
  const content = lines
    .map((line) => compactWhitespace(line))
    .filter(Boolean)
    .join("\n");
  return `${MESSAGE_PREFIX}\n${content}\n${MESSAGE_SUFFIX}`;
}

function wrapCoachMessage(coreMessage: string): string {
  return compactWhitespace(coreMessage);
}

function stripSmsLinks(body: string): string {
  const urlPattern =
    /(?:https?:\/\/|www\.)\S+|\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:\/\S*)?/gi;
  const allowedUrls = new Set([GOOGLE_REVIEW_URL]);

  return body
    .split("\n")
    .map((line) => {
      urlPattern.lastIndex = 0;
      const hadUrl = urlPattern.test(line);

      if (
        hadUrl &&
        /^(Profile|Session Plan|Session|Feedback|Tests)\s*:/i.test(line.trim())
      ) {
        return "";
      }

      return line
        .replace(urlPattern, (match) => {
          const strippedTrailingPunctuation = match.replace(/[.,!?]+$/, "");
          return allowedUrls.has(strippedTrailingPunctuation) ? match : "";
        })
        .replace(/\s+([.,!?])/g, "$1")
        .replace(/\s{2,}/g, " ")
        .trim();
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function toPlayerLabel(playerNames: string[] | null): string {
  const names = (playerNames || []).filter(Boolean);
  if (names.length === 0) return "your player";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
}

function toCombinedParentDisplayName(
  parentName: string,
  secondaryParentName: string | null
): string {
  if (secondaryParentName && secondaryParentName.trim()) {
    return `${parentName} and ${secondaryParentName.trim()}`;
  }
  return parentName;
}

function toParentDisplayName(row: DueReminderRow): string {
  return toCombinedParentDisplayName(row.parent_name, row.secondary_parent_name);
}

function templateUrl(
  template: string | undefined,
  vars: Record<string, string>
): string | null {
  if (!template) return null;

  const value = template.replace(/\{(\w+)\}/g, (full, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : full;
  });

  try {
    const parsed = new URL(value);
    return parsed.toString();
  } catch {
    return null;
  }
}

function parsePositiveInt(
  value: string | null,
  defaultValue: number,
  min: number,
  max: number
): number {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function parseOptionalInt(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.trunc(parsed);
}

function parseReminderTypes(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

let appTableStatusPromise:
  | Promise<{ hasPlayers: boolean; hasCrmPlayerIdColumn: boolean; hasPlayerFeedback: boolean }>
  | null = null;

const appReminderContextCache = new Map<number, Promise<AppReminderContext | null>>();

async function getAppTableStatus() {
  if (!appTableStatusPromise) {
    appTableStatusPromise = (async () => {
      const result = await query(
        `
          SELECT
            to_regclass('public.players') IS NOT NULL AS has_players,
            to_regclass('public.player_feedback') IS NOT NULL AS has_player_feedback,
            EXISTS (
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'players'
                AND column_name = 'crm_player_id'
            ) AS has_crm_player_id_column
        `
      );

      const row = result.rows[0] as {
        has_players: boolean;
        has_player_feedback: boolean;
        has_crm_player_id_column: boolean;
      };

      return {
        hasPlayers: Boolean(row?.has_players),
        hasCrmPlayerIdColumn: Boolean(row?.has_crm_player_id_column),
        hasPlayerFeedback: Boolean(row?.has_player_feedback),
      };
    })();
  }

  return appTableStatusPromise;
}

async function fetchAppReminderContext(
  crmPlayerId: number | null
): Promise<AppReminderContext | null> {
  if (!crmPlayerId) return null;

  const cached = appReminderContextCache.get(crmPlayerId);
  if (cached) return cached;

  const pending = (async (): Promise<AppReminderContext | null> => {
    const tableStatus = await getAppTableStatus();
    if (!tableStatus.hasPlayers || !tableStatus.hasCrmPlayerIdColumn) {
      return null;
    }

    const appPlayerResult = await query(
      `
        SELECT id::text AS app_player_id
        FROM players
        WHERE crm_player_id = $1
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT 1
      `,
      [crmPlayerId]
    );

    const appPlayerRow = appPlayerResult.rows[0] as { app_player_id?: string } | undefined;
    const appPlayerId = appPlayerRow?.app_player_id;
    if (!appPlayerId) {
      return null;
    }

    const latestSessionResult = await query(
      `
        WITH combined AS (
          SELECT s.id::text AS session_id, s.session_date
          FROM crm_sessions s
          LEFT JOIN crm_session_players sp ON sp.session_id = s.id
          WHERE (sp.player_id = $1 OR s.player_id = $1)
            AND COALESCE(s.cancelled, false) = false
            AND (s.status IS NULL OR s.status NOT IN ('cancelled', 'no_show'))
          UNION ALL
          SELECT fs.id::text AS session_id, fs.session_date
          FROM crm_first_sessions fs
          LEFT JOIN crm_first_session_players fsp ON fsp.first_session_id = fs.id
          WHERE (fsp.player_id = $1 OR fs.player_id = $1)
            AND COALESCE(fs.cancelled, false) = false
            AND (fs.status IS NULL OR fs.status NOT IN ('cancelled', 'no_show'))
        )
        SELECT session_id
        FROM combined
        ORDER BY session_date DESC
        LIMIT 1
      `,
      [crmPlayerId]
    );

    let latestFeedbackId: string | null = null;
    let latestFeedbackTitle: string | null = null;
    let latestFeedbackBlurb: string | null = null;
    if (tableStatus.hasPlayerFeedback) {
      const feedbackResult = await query(
        `
          SELECT id::text AS id, title, cleaned_markdown_content, raw_content
          FROM player_feedback
          WHERE player_id::text = $1::text
          ORDER BY updated_at DESC, created_at DESC
          LIMIT 1
        `,
        [appPlayerId]
      );

      const feedbackRow = feedbackResult.rows[0] as
        | {
            id?: string;
            title?: string | null;
            cleaned_markdown_content?: string | null;
            raw_content?: string | null;
          }
        | undefined;
      latestFeedbackId = feedbackRow?.id ?? null;
      latestFeedbackTitle = feedbackRow?.title?.trim() || null;
      const feedbackContent =
        feedbackRow?.cleaned_markdown_content?.trim() ||
        feedbackRow?.raw_content?.trim() ||
        "";
      latestFeedbackBlurb = feedbackContent
        ? clip(toPlainTextFromMarkdown(feedbackContent), 100)
        : null;
    }

    const latestSessionId =
      (latestSessionResult.rows[0] as { session_id?: string } | undefined)?.session_id ?? null;

    return {
      appPlayerId,
      latestSessionId,
      latestFeedbackId,
      latestFeedbackTitle,
      latestFeedbackBlurb,
    };
  })();

  appReminderContextCache.set(crmPlayerId, pending);
  return pending;
}

async function getSameDayNotes(parentId: number, sessionDate: Date): Promise<string[]> {
  const { start, end } = getDateBoundsArizona(sessionDate);

  const result = await query(
    `SELECT notes
     FROM (
       SELECT notes, session_date
       FROM crm_first_sessions
       WHERE parent_id = $1
         AND session_date >= $2
         AND session_date <= $3
         AND COALESCE(cancelled, false) = false
         AND notes IS NOT NULL
         AND TRIM(notes) <> ''
       UNION ALL
       SELECT notes, session_date
       FROM crm_sessions
       WHERE parent_id = $1
         AND session_date >= $2
         AND session_date <= $3
         AND COALESCE(cancelled, false) = false
         AND notes IS NOT NULL
         AND TRIM(notes) <> ''
     ) combined
     ORDER BY session_date DESC`,
    [parentId, start, end]
  );

  return result.rows
    .map((row: { notes: unknown }) =>
      typeof row.notes === "string" ? compactWhitespace(row.notes) : ""
    )
    .filter(Boolean);
}

function formatReminderTime(dateValue: string | Date): string {
  const date = normalizeUtcDate(dateValue);
  return formatArizonaDateTime(date);
}

async function sendCoachDeliveryConfirmation(
  row: DueReminderRow,
  destination: string
): Promise<{ ok: boolean; detail: string }> {
  const coachPhone = getCoachPhoneNumber();
  const dueAtArizona = formatInTimeZone(
    normalizeUtcDate(row.due_at),
    "America/Phoenix",
    "yyyy-MM-dd h:mm a zzz"
  );
  const sentAtArizona = formatInTimeZone(
    new Date(),
    "America/Phoenix",
    "yyyy-MM-dd h:mm a zzz"
  );
  const recipientLabel = toParentDisplayName(row);
  const body = compactWhitespace(
    `Auto reminder sent: ${row.reminder_type} to ${destination} (${recipientLabel}) due ${dueAtArizona}. Sent at ${sentAtArizona}.`
  );

  const notifyResult = await sendSmsViaTwilio(coachPhone, body);
  if (!notifyResult.ok) {
    return {
      ok: false,
      detail: `coach-notify-failed:${clip(notifyResult.error || "unknown", 250)}`,
    };
  }

  return {
    ok: true,
    detail: `coach-notified:${notifyResult.sid || "ok"}`,
  };
}

async function buildMessage(
  row: DueReminderRow,
  defaultsMap: Record<string, ReminderDefaultRow>
): Promise<PreparedMessage | null> {
  if (!row.session_date) {
    return null;
  }

  const sessionDate = normalizeUtcDate(row.session_date);
  const sessionTimeText = formatReminderTime(sessionDate);
  const parentDisplay = toParentDisplayName(row);
  const playerLabel = toPlayerLabel(row.player_names);
  const dateKey = formatInTimeZone(sessionDate, "America/Phoenix", "yyyy-MM-dd");

  const profileUrl = templateUrl(process.env.PARENT_PROFILE_URL_TEMPLATE, {
    parentId: String(row.parent_id),
    date: dateKey,
    sessionId: row.session_id ? String(row.session_id) : "",
    firstSessionId: row.first_session_id ? String(row.first_session_id) : "",
  });
  const feedbackUrl = templateUrl(process.env.PARENT_FEEDBACK_URL_TEMPLATE, {
    parentId: String(row.parent_id),
    date: dateKey,
    sessionId: row.session_id ? String(row.session_id) : "",
    firstSessionId: row.first_session_id ? String(row.first_session_id) : "",
  });
  const testsUrl = templateUrl(process.env.PARENT_TESTS_URL_TEMPLATE, {
    parentId: String(row.parent_id),
    date: dateKey,
    sessionId: row.session_id ? String(row.session_id) : "",
    firstSessionId: row.first_session_id ? String(row.first_session_id) : "",
  });

  const templateOverride = (row.custom_message || "").trim();
  const templateDefault =
    defaultsMap[row.reminder_type]?.is_active !== false
      ? (defaultsMap[row.reminder_type]?.message_template || "").trim()
      : "";
  const templateToUse = templateOverride || templateDefault;

  if (templateToUse) {
    const needsCoachRecipient = row.reminder_type.startsWith("coach_");
    const destination = needsCoachRecipient
      ? getCoachPhoneNumber()
      : normalizeUsPhoneNumber(row.parent_phone);
    if (!destination) return null;

    const includesAppLinks =
      /\{\{\s*(profile_url|session_plan_url|feedback_url|tests_url|player_profile_url|player_sessions_url|player_feedback_url|player_tests_url)\s*\}\}/.test(
        templateToUse
      );
    const appContext = includesAppLinks
      ? await fetchAppReminderContext(row.primary_crm_player_id)
      : null;
    const basePlayerUrl = appContext
      ? `https://app.davidssoccertraining.com/player/${encodeURIComponent(appContext.appPlayerId)}`
      : profileUrl;
    const sessionPlanUrl = appContext
      ? appContext.latestSessionId
        ? `${basePlayerUrl}#tab=sessions&sessionId=${encodeURIComponent(appContext.latestSessionId)}`
        : `${basePlayerUrl}#tab=sessions`
      : profileUrl;
    const feedbackTabUrl = appContext
      ? appContext.latestFeedbackId
        ? `${basePlayerUrl}#feedback:${encodeURIComponent(appContext.latestFeedbackId)}`
        : `${basePlayerUrl}#feedback`
      : feedbackUrl;
    const testsTabUrl = appContext ? `${basePlayerUrl}#tests` : testsUrl;

    const notes = await getSameDayNotes(row.parent_id, sessionDate);
    const notesSummary = notes.length
      ? clip(notes.join(" | "), 220)
      : "Coach David will follow up with any notes from today's session.";
    const firstSessionNote =
      row.total_sessions_through_current === 1
        ? "Since this is your first session, reach out to Coach David with any questions."
        : "";
    const reviewPrompt =
      row.total_sessions_through_current === 3
        ? "This is session #3, ask for a review and capture quick feedback."
        : "";

    const rendered = normalizeTemplateOutput(
      renderTemplate(templateToUse, {
        reminder_type: row.reminder_type,
        player_name: playerLabel,
        parent_name: parentDisplay,
        session_time: sessionTimeText,
        date_key: dateKey,
        profile_url: basePlayerUrl || profileUrl || "",
        session_plan_url: sessionPlanUrl || profileUrl || "",
        feedback_url: feedbackTabUrl || feedbackUrl || "",
        tests_url: testsTabUrl || testsUrl || "",
        notes_summary: notesSummary,
        first_session_note: firstSessionNote,
        review_prompt: reviewPrompt,
        coach_phone: getCoachPhoneNumber(),
      })
    );

    if (!rendered) return null;

    return {
      to: destination,
      body: needsCoachRecipient
        ? wrapCoachMessage(rendered.replace(/\n+/g, " "))
        : wrapMessageLines(rendered.split("\n")),
    };
  }

  switch (row.reminder_type) {
    case "session_48h":
    case "session_24h":
    case "session_6h": {
      const labelMap: Record<string, string> = {
        session_48h: "48-hour",
        session_24h: "24-hour",
        session_6h: "6-hour",
      };

      const parentPhone = normalizeUsPhoneNumber(row.parent_phone);
      if (!parentPhone) return null;

      return {
        to: parentPhone,
        body: wrapMessage(
          `${labelMap[row.reminder_type]} reminder for ${playerLabel}: session at ${sessionTimeText}.`
        ),
      };
    }
    case "session_start": {
      const parentPhone = normalizeUsPhoneNumber(row.parent_phone);
      if (!parentPhone) return null;

      return {
        to: parentPhone,
        body: wrapMessage(
          `Session time reminder for ${playerLabel}: session starts now at ${sessionTimeText}.`
        ),
      };
    }
    case "coach_session_start": {
      return {
        to: getCoachPhoneNumber(),
        body: wrapCoachMessage(
          `Coach reminder: ${playerLabel} with ${parentDisplay} starts now (${sessionTimeText}). Get photos, videos, and sports drink ready.`
        ),
      };
    }
    case "coach_session_plus_60m": {
      const reviewPrompt =
        row.total_sessions_through_current === 3
          ? " This is session #3, ask for a review and capture quick feedback."
          : "";

      return {
        to: getCoachPhoneNumber(),
        body: wrapCoachMessage(
          `60-minute follow-up: if not already done, get a photo with ${playerLabel}.${reviewPrompt}`
        ),
      };
    }
    case "parent_session_plus_120m": {
      const parentPhone = normalizeUsPhoneNumber(row.parent_phone);
      if (!parentPhone) return null;

      return {
        to: parentPhone,
        body: wrapMessage(
          `Thank you for training with David today, ${parentDisplay}. Feel free to reach out to schedule again. If you have a minute, please leave a review: ${GOOGLE_REVIEW_URL}`
        ),
      };
    }
    default:
      return null;
  }
}

async function markReminderSent(reminderId: number, note: string) {
  await query(
    `UPDATE crm_reminders
     SET sent = true,
         sent_at = CURRENT_TIMESTAMP,
         notes = CASE
           WHEN notes IS NULL OR notes = '' THEN $2
           ELSE notes || E'\n' || $2
         END
     WHERE id = $1`,
    [reminderId, note]
  );
}

async function appendReminderNote(reminderId: number, note: string) {
  await query(
    `UPDATE crm_reminders
     SET notes = CASE
       WHEN notes IS NULL OR notes = '' THEN $2
       ELSE notes || E'\n' || $2
     END
     WHERE id = $1`,
    [reminderId, note]
  );
}

async function markCustomMessageSent(messageId: number, note: string) {
  await query(
    `UPDATE crm_custom_scheduled_messages
     SET sent = true,
         sent_at = CURRENT_TIMESTAMP,
         notes = CASE
           WHEN notes IS NULL OR notes = '' THEN $2
           ELSE notes || E'\n' || $2
         END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [messageId, note]
  );
}

async function appendCustomMessageNote(messageId: number, note: string) {
  await query(
    `UPDATE crm_custom_scheduled_messages
     SET notes = CASE
       WHEN notes IS NULL OR notes = '' THEN $2
       ELSE notes || E'\n' || $2
     END,
     updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [messageId, note]
  );
}

async function processDueCustomMessages(
  limit: number,
  options: ReminderProcessingOptions
): Promise<CustomMessageStats> {
  const dueMessages = await query(
    `
      SELECT
        m.id,
        m.parent_id,
        m.title,
        m.message_content,
        m.scheduled_for,
        p.name as parent_name,
        p.secondary_parent_name,
        p.phone as parent_phone
      FROM crm_custom_scheduled_messages m
      JOIN crm_parents p ON p.id = m.parent_id
      WHERE m.sent = false
        AND m.scheduled_for >= ($2::timestamptz AT TIME ZONE 'UTC')
        AND m.scheduled_for <= ($3::timestamptz AT TIME ZONE 'UTC')
        AND ($4::int IS NULL OR m.parent_id = $4::int)
        AND COALESCE(p.is_dead, false) = false
      ORDER BY m.scheduled_for ASC, m.id ASC
      LIMIT $1
    `,
    [limit, options.lowerBoundIso, options.upperBoundIso, options.parentId]
  );

  const stats: CustomMessageStats = {
    fetched: dueMessages.rows.length,
    sent: 0,
    skipped: 0,
    failed: 0,
    previewed: 0,
    preview: [],
  };

  for (const row of dueMessages.rows as CustomScheduledMessageRow[]) {
    const parentPhone = normalizeUsPhoneNumber(row.parent_phone);
    if (!parentPhone) {
      if (!options.dryRun && options.markSent) {
        await markCustomMessageSent(
          row.id,
          "auto-skipped: missing recipient phone number"
        );
      }
      stats.skipped += 1;
      continue;
    }

    const parentDisplay = toCombinedParentDisplayName(
      row.parent_name,
      row.secondary_parent_name
    );
    const scheduledForText = formatArizonaDateTime(normalizeUtcDate(row.scheduled_for));
    const rendered = normalizeTemplateOutput(
      renderTemplate(row.message_content, {
        parent_name: parentDisplay,
        scheduled_time: scheduledForText,
        coach_phone: getCoachPhoneNumber(),
      })
    );
    if (!rendered) {
      if (!options.dryRun && options.markSent) {
        await markCustomMessageSent(row.id, "auto-skipped: empty message content");
      }
      stats.skipped += 1;
      continue;
    }

    const destination = options.overrideTo || parentPhone;
    const body = stripSmsLinks(wrapMessage(rendered));

    if (options.dryRun) {
      stats.previewed += 1;
      if (stats.preview.length < 25) {
        stats.preview.push({
          id: row.id,
          dueAt: normalizeUtcDate(row.scheduled_for).toISOString(),
          to: destination,
        });
      }
      continue;
    }

    try {
      const smsResult = await sendSmsViaTwilio(destination, body);

      if (smsResult.ok) {
        const detail = `sms-sent:${smsResult.sid || "ok"}:${smsResult.status || "queued"}`;
        if (options.markSent) {
          await markCustomMessageSent(row.id, detail);
        }
        stats.sent += 1;
      } else {
        if (options.markSent) {
          await appendCustomMessageNote(
            row.id,
            `sms-failed:${clip(smsResult.error || "unknown", 300)}`
          );
        }
        stats.failed += 1;
      }
    } catch (error) {
      if (options.markSent) {
        const message =
          error instanceof Error ? error.message : "Unknown SMS send exception";
        await appendCustomMessageNote(row.id, `sms-exception:${clip(message, 300)}`);
      }
      stats.failed += 1;
    }
  }

  return stats;
}

async function processDueReminders(
  limit: number,
  options: ReminderProcessingOptions
): Promise<ReminderStats> {
  const defaultsMap = await getSessionReminderDefaultsMap();
  const dueReminders = await query(
    `SELECT
      r.id,
      r.parent_id,
      r.session_id,
      r.first_session_id,
      r.reminder_type,
      r.due_at,
      r.custom_message,
      p.name as parent_name,
      p.secondary_parent_name,
      p.phone as parent_phone,
      COALESCE(s.session_date, fs.session_date) as session_date,
      COALESCE(
        CASE
          WHEN r.session_id IS NOT NULL THEN (
            SELECT sp.player_id
            FROM crm_session_players sp
            WHERE sp.session_id = r.session_id
            ORDER BY sp.created_at ASC, sp.id ASC
            LIMIT 1
          )
          WHEN r.first_session_id IS NOT NULL THEN (
            SELECT fsp.player_id
            FROM crm_first_session_players fsp
            WHERE fsp.first_session_id = r.first_session_id
            ORDER BY fsp.created_at ASC, fsp.id ASC
            LIMIT 1
          )
          ELSE NULL
        END,
        s.player_id,
        fs.player_id
      ) as primary_crm_player_id,
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
      END as player_names,
      (
        SELECT COUNT(*)::int
        FROM (
          SELECT fs2.id
          FROM crm_first_sessions fs2
          WHERE fs2.parent_id = r.parent_id
            AND COALESCE(fs2.cancelled, false) = false
            AND (fs2.status IS NULL OR fs2.status NOT IN ('cancelled', 'no_show'))
            AND fs2.session_date <= COALESCE(s.session_date, fs.session_date)
          UNION ALL
          SELECT s2.id
          FROM crm_sessions s2
          WHERE s2.parent_id = r.parent_id
            AND COALESCE(s2.cancelled, false) = false
            AND (s2.status IS NULL OR s2.status NOT IN ('cancelled', 'no_show'))
            AND s2.session_date <= COALESCE(s.session_date, fs.session_date)
        ) session_counts
      ) as total_sessions_through_current
    FROM crm_reminders r
    JOIN crm_parents p ON p.id = r.parent_id
    LEFT JOIN crm_sessions s ON s.id = r.session_id
    LEFT JOIN crm_first_sessions fs ON fs.id = r.first_session_id
    WHERE r.sent = false
      AND r.reminder_category = 'session_reminder'
      AND r.due_at >= ($2::timestamptz AT TIME ZONE 'UTC')
      AND r.due_at <= ($3::timestamptz AT TIME ZONE 'UTC')
      AND ($4::int IS NULL OR r.parent_id = $4::int)
      AND ($5::int IS NULL OR r.session_id = $5::int)
      AND ($6::int IS NULL OR r.first_session_id = $6::int)
      AND (
        COALESCE(array_length($7::text[], 1), 0) = 0
        OR r.reminder_type = ANY($7::text[])
      )
      AND COALESCE(p.is_dead, false) = false
      AND (
        r.session_id IS NULL
        OR (
          COALESCE(s.cancelled, false) = false
          AND (s.status IS NULL OR s.status NOT IN ('cancelled', 'no_show'))
        )
      )
      AND (
        r.first_session_id IS NULL
        OR (
          COALESCE(fs.cancelled, false) = false
          AND (fs.status IS NULL OR fs.status NOT IN ('cancelled', 'no_show'))
        )
      )
    ORDER BY r.due_at ASC, r.id ASC
    LIMIT $1`,
    [
      limit,
      options.lowerBoundIso,
      options.upperBoundIso,
      options.parentId,
      options.sessionId,
      options.firstSessionId,
      options.reminderTypes,
    ]
  );

  const stats: ReminderStats = {
    fetched: dueReminders.rows.length,
    sent: 0,
    skipped: 0,
    failed: 0,
    previewed: 0,
    preview: [],
  };

  for (const row of dueReminders.rows as DueReminderRow[]) {
    const prepared = await buildMessage(row, defaultsMap);

    if (!prepared) {
      if (!options.dryRun && options.markSent) {
        await markReminderSent(
          row.id,
          "auto-skipped: missing recipient phone or unsupported type"
        );
      }
      stats.skipped += 1;
      continue;
    }

    const destination = options.overrideTo || prepared.to;

    if (options.dryRun) {
      stats.previewed += 1;
      if (stats.preview.length < 25) {
        stats.preview.push({
          id: row.id,
          reminderType: row.reminder_type,
          dueAt: normalizeUtcDate(row.due_at).toISOString(),
          to: destination,
        });
      }
      continue;
    }

    try {
      const smsResult = await sendSmsViaTwilio(
        destination,
        stripSmsLinks(prepared.body)
      );

      if (smsResult.ok) {
        const noteParts = [`sms-sent:${smsResult.sid || "ok"}:${smsResult.status || "queued"}`];
        try {
          const coachNotify = await sendCoachDeliveryConfirmation(row, destination);
          noteParts.push(coachNotify.detail);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown coach notify exception";
          noteParts.push(`coach-notify-exception:${clip(message, 250)}`);
        }

        if (options.markSent) {
          await markReminderSent(row.id, noteParts.join(" | "));
        }
        stats.sent += 1;
      } else {
        if (options.markSent) {
          await appendReminderNote(
            row.id,
            `sms-failed:${clip(smsResult.error || "unknown", 300)}`
          );
        }
        stats.failed += 1;
      }
    } catch (error) {
      if (options.markSent) {
        const message =
          error instanceof Error ? error.message : "Unknown SMS send exception";
        await appendReminderNote(row.id, `sms-exception:${clip(message, 300)}`);
      }
      stats.failed += 1;
    }
  }

  return stats;
}

export async function POST(request: Request) {
  try {
    await ensureAutoRemindersSchema();
    const cronHeader = request.headers.get("x-vercel-cron");
    const authHeader = request.headers.get("authorization");
    const url = new URL(request.url);

    const isVercelCron = cronHeader === "1";
    const isManualWithSecret = authHeader === `Bearer ${process.env.CRON_SECRET}`;

    if (!isVercelCron && !isManualWithSecret) {
      return new Response("Unauthorized", { status: 401 });
    }

    const testMode = url.searchParams.get("test_mode") === "1";
    if (testMode && !isManualWithSecret) {
      return new Response("Unauthorized test mode", { status: 401 });
    }

    const batchSize = parsePositiveInt(
      url.searchParams.get("batch_size"),
      parsePositiveInt(process.env.SMS_REMINDER_BATCH_SIZE ?? null, 60, 1, 200),
      1,
      200
    );

    const windowMinutes = parsePositiveInt(
      url.searchParams.get("window_minutes"),
      parsePositiveInt(process.env.SMS_REMINDER_WINDOW_MINUTES ?? null, 15, 1, 120),
      1,
      120
    );

    const lookaheadMinutes = parsePositiveInt(
      url.searchParams.get("lookahead_minutes"),
      testMode ? 180 : 0,
      0,
      30 * 24 * 60
    );

    const dryRunParam = url.searchParams.get("dry_run");
    const dryRun = dryRunParam === null ? testMode : dryRunParam === "1";

    const markSentParam = url.searchParams.get("mark_sent");
    const markSent = dryRun
      ? false
      : markSentParam === null
        ? !testMode
        : markSentParam === "1";

    const overrideTo = testMode
      ? normalizeUsPhoneNumber(
          url.searchParams.get("test_to") || process.env.COACH_PHONE_NUMBER || "7206122979"
        )
      : null;

    const parentId = parseOptionalInt(url.searchParams.get("parent_id"));
    const sessionId = parseOptionalInt(url.searchParams.get("session_id"));
    const firstSessionId = parseOptionalInt(url.searchParams.get("first_session_id"));
    const reminderTypes = parseReminderTypes(url.searchParams.get("types"));
    const includeCustomMessagesParam = url.searchParams.get(
      "include_custom_messages"
    );
    const includeCustomMessages =
      includeCustomMessagesParam === null
        ? true
        : includeCustomMessagesParam === "1";

    if (testMode && !overrideTo) {
      return errorResponse("Invalid test_to phone number", 400);
    }

    const now = new Date();
    const lowerBoundIso = testMode
      ? now.toISOString()
      : new Date(now.getTime() - windowMinutes * 60 * 1000).toISOString();
    const upperBoundIso = testMode
      ? new Date(now.getTime() + lookaheadMinutes * 60 * 1000).toISOString()
      : now.toISOString();

    const stats = await processDueReminders(batchSize, {
      lowerBoundIso,
      upperBoundIso,
      dryRun,
      markSent,
      overrideTo,
      parentId,
      sessionId,
      firstSessionId,
      reminderTypes,
    });
    const customMessageStats = includeCustomMessages
      ? await processDueCustomMessages(batchSize, {
          lowerBoundIso,
          upperBoundIso,
          dryRun,
          markSent,
          overrideTo,
          parentId,
          sessionId,
          firstSessionId,
          reminderTypes,
        })
      : null;

    return jsonResponse({
      success: true,
      timestamp: new Date().toISOString(),
      arizonaNow: formatInTimeZone(new Date(), "America/Phoenix", "yyyy-MM-dd HH:mm:ss zzz"),
      batchSize,
      windowMinutes,
      lookaheadMinutes,
      lowerBoundIso,
      upperBoundIso,
      testMode,
      dryRun,
      markSent,
      overrideTo,
      parentId,
      sessionId,
      firstSessionId,
      reminderTypes,
      includeCustomMessages,
      stats,
      customMessageStats,
    });
  } catch (error) {
    console.error("Error in send reminders cron:", error);
    return errorResponse("Failed to send reminders");
  }
}

export async function GET(request: Request) {
  const cronHeader = request.headers.get("x-vercel-cron");
  const authHeader = request.headers.get("authorization");
  const isManualWithSecret = authHeader === `Bearer ${process.env.CRON_SECRET}`;

  if (cronHeader === "1" || isManualWithSecret) {
    const headers = new Headers();
    if (cronHeader === "1") {
      headers.set("x-vercel-cron", "1");
    }
    if (isManualWithSecret && authHeader) {
      headers.set("authorization", authHeader);
    }

    const cronRequest = new Request(request.url, {
      method: "POST",
      headers,
    });
    return POST(cronRequest);
  }

  const url = new URL(request.url);
  const secret = url.searchParams.get("secret");

  if (secret !== process.env.CRON_SECRET) {
    return new Response("Unauthorized - add ?secret=YOUR_CRON_SECRET to test", {
      status: 401,
    });
  }

  const mockRequest = new Request(request.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.CRON_SECRET}`,
    },
  });

  return POST(mockRequest);
}
