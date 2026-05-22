import { query } from "@/lib/db";
import { SESSION_REMINDER_TYPES } from "@/lib/reminders";

export interface ReminderDefaultRow {
  reminder_type: string;
  message_template: string;
  is_active: boolean;
  updated_at: string;
}

export interface CustomMessageTemplateRow {
  id: number;
  name: string;
  message_template: string;
  created_at: string;
  updated_at: string;
}

export interface PlaceholderValidationResult {
  ok: boolean;
  expected: string[];
  found: string[];
  missing: string[];
  extra: string[];
}

export const SESSION_REMINDER_TYPE_LABELS: Record<string, string> = {
  session_48h: "48 hours before session",
  session_24h: "24 hours before session",
  session_6h: "6 hours before session",
  session_start: "At session start (parent)",
  coach_session_start: "At session start (coach)",
  coach_session_plus_60m: "60 minutes after start (coach)",
  parent_session_plus_120m: "180 minutes after end (parent)",
};

const LEGACY_SESSION_START_TEMPLATE = [
  "Session time for {{player_name}}.",
  "Profile: {{profile_url}}",
  "Session Plan: {{session_plan_url}}",
  "{{first_session_note}}",
].join("\n");

const LEGACY_PARENT_SESSION_PLUS_120M_TEMPLATE = [
  "Thank you for training with David today, {{parent_name}}.",
  "Today's feedback: {{notes_summary}}",
  "Profile: {{profile_url}}",
  "Feedback: {{feedback_url}}",
  "Tests: {{tests_url}}",
].join("\n");

const PREVIOUS_PARENT_SESSION_PLUS_120M_TEMPLATE =
  "Thank you for training with David today, {{parent_name}}. When you're ready, reach out to schedule your next sessions.";

export const SESSION_REMINDER_DEFAULT_TEMPLATES: Record<string, string> = {
  session_48h:
    "48-hour reminder for {{player_name}}: session at {{session_time}}.",
  session_24h:
    "24-hour reminder for {{player_name}}: session at {{session_time}}.",
  session_6h:
    "6-hour reminder for {{player_name}}: session at {{session_time}}.",
  session_start:
    "Session time reminder for {{player_name}}: session starts now at {{session_time}}.",
  coach_session_start:
    "Coach reminder: {{player_name}} with {{parent_name}} starts now ({{session_time}}). Get photos, videos, and sports drink ready.",
  coach_session_plus_60m:
    "60-minute follow-up: if not already done, get a photo with {{player_name}}. {{review_prompt}}",
  parent_session_plus_120m:
    "Thank you for training with David today, {{parent_name}}. Feel free to reach out to schedule again. If you have a minute, please leave a review: https://g.page/r/CbrmGhQt_77aEAI/review",
};

const LEGACY_DEFAULT_TEMPLATES: Record<string, string[]> = {
  session_start: [LEGACY_SESSION_START_TEMPLATE],
  parent_session_plus_120m: [
    LEGACY_PARENT_SESSION_PLUS_120M_TEMPLATE,
    PREVIOUS_PARENT_SESSION_PLUS_120M_TEMPLATE,
  ],
};

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

export function extractTemplatePlaceholders(template: string): string[] {
  const matches = template.match(/\{\{\s*(\w+)\s*\}\}/g) || [];
  const names = matches.map((match) =>
    match.replace(/\{\{\s*|\s*\}\}/g, "").trim()
  );
  return uniqueSorted(names.filter(Boolean));
}

export function getLockedPlaceholdersForReminderType(
  reminderType: string
): string[] {
  const baseTemplate = SESSION_REMINDER_DEFAULT_TEMPLATES[reminderType] || "";
  return extractTemplatePlaceholders(baseTemplate);
}

export function validateLockedPlaceholders(
  reminderType: string,
  candidateTemplate: string
): PlaceholderValidationResult {
  const expected = getLockedPlaceholdersForReminderType(reminderType);
  const found = extractTemplatePlaceholders(candidateTemplate);
  const expectedSet = new Set(expected);
  const foundSet = new Set(found);

  const missing = expected.filter((name) => !foundSet.has(name));
  const extra = found.filter((name) => !expectedSet.has(name));

  return {
    ok: missing.length === 0 && extra.length === 0,
    expected,
    found,
    missing,
    extra,
  };
}

let schemaReadyPromise: Promise<void> | null = null;

export async function ensureAutoRemindersSchema() {
  if (schemaReadyPromise) return schemaReadyPromise;

  schemaReadyPromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS crm_reminder_defaults (
        reminder_type TEXT PRIMARY KEY,
        message_template TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await query(`
      ALTER TABLE crm_reminders
      ADD COLUMN IF NOT EXISTS custom_message TEXT
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS crm_custom_message_templates (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        message_template TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS crm_custom_scheduled_messages (
        id BIGSERIAL PRIMARY KEY,
        parent_id BIGINT NOT NULL REFERENCES crm_parents(id) ON DELETE CASCADE,
        title TEXT,
        message_content TEXT NOT NULL,
        scheduled_for TIMESTAMP NOT NULL,
        sent BOOLEAN NOT NULL DEFAULT FALSE,
        sent_at TIMESTAMPTZ,
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_crm_custom_scheduled_messages_due
      ON crm_custom_scheduled_messages (sent, scheduled_for)
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_crm_custom_scheduled_messages_parent
      ON crm_custom_scheduled_messages (parent_id, sent, scheduled_for)
    `);

    for (const reminderType of SESSION_REMINDER_TYPES) {
      const defaultTemplate =
        SESSION_REMINDER_DEFAULT_TEMPLATES[reminderType] ??
        `${reminderType} reminder: {{session_time}}`;
      const legacyTemplates = LEGACY_DEFAULT_TEMPLATES[reminderType];

      if (legacyTemplates) {
        await query(
          `
            INSERT INTO crm_reminder_defaults (reminder_type, message_template)
            VALUES ($1, $2)
            ON CONFLICT (reminder_type) DO UPDATE
            SET message_template = EXCLUDED.message_template,
                updated_at = CURRENT_TIMESTAMP
            WHERE crm_reminder_defaults.message_template = ANY($3::text[])
          `,
          [reminderType, defaultTemplate, legacyTemplates]
        );
        continue;
      }

      await query(
        `
          INSERT INTO crm_reminder_defaults (reminder_type, message_template)
          VALUES ($1, $2)
          ON CONFLICT (reminder_type) DO NOTHING
        `,
        [reminderType, defaultTemplate]
      );
    }
  })().catch((error) => {
    schemaReadyPromise = null;
    throw error;
  });

  return schemaReadyPromise;
}

export async function getSessionReminderDefaults(): Promise<ReminderDefaultRow[]> {
  await ensureAutoRemindersSchema();
  const result = await query(
    `
      SELECT reminder_type, message_template, is_active, updated_at
      FROM crm_reminder_defaults
      WHERE reminder_type = ANY($1::text[])
      ORDER BY reminder_type ASC
    `,
    [SESSION_REMINDER_TYPES]
  );

  return result.rows as ReminderDefaultRow[];
}

export async function getSessionReminderDefaultsMap(): Promise<
  Record<string, ReminderDefaultRow>
> {
  const rows = await getSessionReminderDefaults();
  return rows.reduce<Record<string, ReminderDefaultRow>>((acc, row) => {
    acc[row.reminder_type] = row;
    return acc;
  }, {});
}
