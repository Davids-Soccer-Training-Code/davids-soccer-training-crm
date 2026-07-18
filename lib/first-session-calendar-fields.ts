import { query } from '@/lib/db';

let ensureFirstSessionCalendarColumnsPromise: Promise<void> | null = null;
const DEFAULT_FIRST_SESSION_DURATION_MINUTES = 60;

export async function ensureFirstSessionCalendarColumns(): Promise<void> {
  if (ensureFirstSessionCalendarColumnsPromise) {
    await ensureFirstSessionCalendarColumnsPromise;
    return;
  }

  ensureFirstSessionCalendarColumnsPromise = (async () => {
    await query(`ALTER TABLE crm_first_sessions ADD COLUMN IF NOT EXISTS title TEXT`);
    await query(`ALTER TABLE crm_first_sessions ADD COLUMN IF NOT EXISTS session_end_date TIMESTAMP`);
    await query(`ALTER TABLE crm_first_sessions ADD COLUMN IF NOT EXISTS guest_emails TEXT[]`);
    await query(`ALTER TABLE crm_first_sessions ADD COLUMN IF NOT EXISTS send_email_updates BOOLEAN`);
    await query(`ALTER TABLE crm_first_sessions ADD COLUMN IF NOT EXISTS coach_id INTEGER REFERENCES crm_staff(id) ON DELETE SET NULL`);
    await query(`ALTER TABLE crm_first_sessions ALTER COLUMN guest_emails SET DEFAULT '{}'::text[]`);
    await query(`ALTER TABLE crm_first_sessions ALTER COLUMN send_email_updates SET DEFAULT false`);
    await query(`
      UPDATE crm_first_sessions
      SET session_end_date = session_date + INTERVAL '60 minutes'
      WHERE session_end_date IS NULL
    `);
    await query(`
      UPDATE crm_first_sessions
      SET guest_emails = '{}'::text[]
      WHERE guest_emails IS NULL
    `);
    await query(`
      UPDATE crm_first_sessions
      SET send_email_updates = false
      WHERE send_email_updates IS NULL
    `);
  })().catch((error) => {
    ensureFirstSessionCalendarColumnsPromise = null;
    throw error;
  });

  await ensureFirstSessionCalendarColumnsPromise;
}

export function defaultFirstSessionEndFromStart(startIso: string): string {
  const startDate = new Date(startIso);
  return new Date(
    startDate.getTime() + DEFAULT_FIRST_SESSION_DURATION_MINUTES * 60 * 1000
  ).toISOString();
}
