/**
 * 48h / 24h / 6h reminder texts for group trainings.
 *
 * Private sessions pre-schedule rows in `crm_reminders`. Group sessions work
 * differently because signups also arrive from the public signup app, which
 * this repo doesn't control, and a family can join the day before. So nothing
 * is scheduled ahead of time. On every cron run we work out which reminder
 * tier each upcoming session is in right now, text anyone on the roster who
 * hasn't had that tier yet, and log each send so it goes out once.
 *
 * Each tier covers the time from its offset down to the next tier's offset.
 * A family added 20 hours out gets the 24h text right away and then the 6h
 * one. They never get a stale "48 hours" text.
 *
 * Families also get a thank-you with the Google review link 3 hours after
 * the session ends, the same one private sessions send.
 */
import { query } from '@/lib/db';
import { normalizeUsPhoneNumber, sendSmsViaTwilio, getCoachPhoneNumber } from '@/lib/twilio';
import { formatSessionWhen } from '@/lib/group-session-notifications';
import { ensureGroupSessionCoachTables } from '@/lib/group-session-coaches';

const HOUR_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;

const MESSAGE_PREFIX = 'Davids Soccer Training. DO NOT REPLY';
const MESSAGE_SUFFIX = 'For any questions, reach out to Coach David at 720 612 2979.';
const GOOGLE_REVIEW_URL = 'https://g.page/r/CbrmGhQt_77aEAI/review';

/** The thank-you goes out this long after the session ends... */
const THANK_YOU_DELAY_HOURS = 3;
/**
 * ...and is dropped if it hasn't gone out within this many hours after that,
 * so a deploy or a cron outage never thanks families for last week's session.
 */
const THANK_YOU_WINDOW_HOURS = 9;

type Audience = 'family' | 'coach';

interface Tier {
  type: string;
  audience: Audience;
  /** Starts sending this many hours before the session... */
  fromHours: number;
  /** ...and stops once the session is this close (the next tier takes over). */
  untilHours: number;
  label: string;
}

export const GROUP_REMINDER_TIERS: Tier[] = [
  { type: 'group_48h', audience: 'family', fromHours: 48, untilHours: 24, label: '48-hour' },
  { type: 'group_24h', audience: 'family', fromHours: 24, untilHours: 6, label: '24-hour' },
  { type: 'group_6h', audience: 'family', fromHours: 6, untilHours: 0, label: '6-hour' },
  { type: 'group_coach_24h', audience: 'coach', fromHours: 24, untilHours: 6, label: '24-hour' },
  { type: 'group_coach_6h', audience: 'coach', fromHours: 6, untilHours: 0, label: '6-hour' },
];

const THANK_YOU_TIER: Tier = {
  type: 'group_thank_you',
  audience: 'family',
  fromHours: -THANK_YOU_DELAY_HOURS,
  untilHours: -(THANK_YOU_DELAY_HOURS + THANK_YOU_WINDOW_HOURS),
  label: 'thank-you',
};

export interface GroupReminderOptions {
  dryRun: boolean;
  markSent: boolean;
  /** Test mode: every text goes to this number instead. */
  overrideTo: string | null;
  /** Pretend it's this much later, to preview upcoming tiers. */
  lookaheadMinutes?: number;
  groupSessionId?: number | null;
}

export interface GroupReminderStats {
  sent: number;
  failed: number;
  skipped: number;
  previewed: number;
  preview: Array<{ groupSessionId: number; reminderType: string; to: string; body: string }>;
}

interface UpcomingSession {
  id: number;
  title: string;
  session_date: string | Date;
  session_date_end: string | Date | null;
  location: string | null;
  price: string | number | null;
}

interface Recipient {
  phone: string;
  /** Kids for a family, coach name for a coach. */
  names: string[];
}

interface SignupRow {
  first_name: string;
  last_name: string;
  contact_phone: string | null;
}

let ensureLogPromise: Promise<void> | null = null;

async function ensureReminderLog(): Promise<void> {
  if (ensureLogPromise) {
    await ensureLogPromise;
    return;
  }

  ensureLogPromise = (async () => {
    await ensureGroupSessionCoachTables();
    await query(`
      CREATE TABLE IF NOT EXISTS group_session_reminder_log (
        id BIGSERIAL PRIMARY KEY,
        group_session_id BIGINT NOT NULL REFERENCES group_sessions(id) ON DELETE CASCADE,
        reminder_type TEXT NOT NULL,
        recipient_phone TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'sending',
        attempts INTEGER NOT NULL DEFAULT 1,
        detail TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (group_session_id, reminder_type, recipient_phone)
      )
    `);
  })().catch((error) => {
    ensureLogPromise = null;
    throw error;
  });

  await ensureLogPromise;
}

function joinNames(names: string[]): string {
  if (names.length === 0) return 'your player';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/** Which tier a session is in for an audience at `nowMs`, or null if none. */
export function activeTier(sessionStartMs: number, nowMs: number, audience: Audience): Tier | null {
  const hoursOut = (sessionStartMs - nowMs) / HOUR_MS;
  return (
    GROUP_REMINDER_TIERS.find(
      (tier) => tier.audience === audience && hoursOut <= tier.fromHours && hoursOut > tier.untilHours
    ) ?? null
  );
}

/** Whether the thank-you is due, measured from the session's end. */
export function thankYouDue(sessionEndMs: number, nowMs: number): boolean {
  const hoursSinceEnd = (nowMs - sessionEndMs) / HOUR_MS;
  return (
    hoursSinceEnd >= THANK_YOU_DELAY_HOURS &&
    hoursSinceEnd < THANK_YOU_DELAY_HOURS + THANK_YOU_WINDOW_HOURS
  );
}

export function buildThankYouSms(playerNames: string[]): string {
  const core =
    `Thank you for bringing ${joinNames(playerNames)} to group training today. ` +
    `Feel free to reach out to sign up again. If you have a minute, please leave a review: ${GOOGLE_REVIEW_URL}`;
  return `${MESSAGE_PREFIX}\n${core}\n${MESSAGE_SUFFIX}`;
}

export function buildFamilyReminderSms(tier: Tier, session: UpcomingSession, playerNames: string[]): string {
  const lines = [
    `${tier.label} reminder: ${joinNames(playerNames)} ${
      playerNames.length === 1 ? 'has' : 'have'
    } group training.`,
    formatSessionWhen(session),
  ];
  if (session.location) lines.push(session.location);
  return `${MESSAGE_PREFIX}\n${lines.join('\n')}\n${MESSAGE_SUFFIX}`;
}

export function buildCoachReminderSms(tier: Tier, session: UpcomingSession, roster: string[]): string {
  const lines = [`Coach ${tier.label} reminder: ${session.title}`, formatSessionWhen(session)];
  if (session.location) lines.push(session.location);
  lines.push(
    roster.length > 0
      ? `${roster.length} player${roster.length === 1 ? '' : 's'}: ${roster.join(', ')}`
      : 'No players signed up yet.'
  );
  return lines.join('\n');
}

/**
 * Who's actually coming. Paid signups, plus anyone the coach put on the roster
 * by hand or from the CRM. Leaves out the unpaid rows the public form writes
 * when a family starts Stripe checkout: those have a checkout session id and
 * are abandoned carts until the webhook flips `has_paid`.
 */
async function getRoster(groupSessionId: number): Promise<SignupRow[]> {
  const result = await query(
    `SELECT first_name, last_name, contact_phone
     FROM player_signups
     WHERE group_session_id = $1
       AND (has_paid = true OR stripe_checkout_session_id IS NULL)
     ORDER BY created_at ASC`,
    [groupSessionId]
  );
  return result.rows as SignupRow[];
}

/** One recipient per phone number, so siblings share a single text. */
function familyRecipients(roster: SignupRow[]): Recipient[] {
  const byPhone = new Map<string, Recipient>();
  for (const row of roster) {
    const phone = normalizeUsPhoneNumber(row.contact_phone);
    if (!phone) continue;
    const existing = byPhone.get(phone);
    if (existing) existing.names.push(row.first_name);
    else byPhone.set(phone, { phone, names: [row.first_name] });
  }
  return [...byPhone.values()];
}

/**
 * The session's assigned coaches. If nobody is assigned, the text goes to
 * Coach David's number so a group session never runs without a heads-up.
 */
async function coachRecipients(groupSessionId: number): Promise<Recipient[]> {
  const result = await query(
    `SELECT st.name, st.phone
     FROM group_session_coaches gsc
     JOIN crm_staff st ON st.id = gsc.staff_id
     WHERE gsc.group_session_id = $1`,
    [groupSessionId]
  );
  const rows = result.rows as Array<{ name: string; phone: string | null }>;

  if (rows.length === 0) {
    return [{ phone: getCoachPhoneNumber(), names: ['Coach David'] }];
  }

  const byPhone = new Map<string, Recipient>();
  for (const row of rows) {
    const phone = normalizeUsPhoneNumber(row.phone);
    if (phone && !byPhone.has(phone)) byPhone.set(phone, { phone, names: [row.name] });
  }
  return [...byPhone.values()];
}

/**
 * Claims the (session, tier, phone) slot before sending, so two overlapping
 * cron runs can't both text the same person. A failed send can be claimed
 * again on a later run, up to MAX_ATTEMPTS.
 */
async function claim(groupSessionId: number, type: string, phone: string): Promise<boolean> {
  const result = await query(
    `INSERT INTO group_session_reminder_log (group_session_id, reminder_type, recipient_phone)
     VALUES ($1, $2, $3)
     ON CONFLICT (group_session_id, reminder_type, recipient_phone) DO UPDATE
       SET status = 'sending',
           attempts = group_session_reminder_log.attempts + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE group_session_reminder_log.status = 'failed'
         AND group_session_reminder_log.attempts < $4
     RETURNING id`,
    [groupSessionId, type, phone, MAX_ATTEMPTS]
  );
  return (result.rowCount ?? 0) > 0;
}

async function alreadySent(groupSessionId: number, type: string, phone: string): Promise<boolean> {
  const result = await query(
    `SELECT 1 FROM group_session_reminder_log
     WHERE group_session_id = $1 AND reminder_type = $2 AND recipient_phone = $3
       AND (status <> 'failed' OR attempts >= $4)`,
    [groupSessionId, type, phone, MAX_ATTEMPTS]
  );
  return (result.rowCount ?? 0) > 0;
}

async function record(groupSessionId: number, type: string, phone: string, status: string, detail: string) {
  await query(
    `UPDATE group_session_reminder_log
     SET status = $4, detail = $5, updated_at = CURRENT_TIMESTAMP
     WHERE group_session_id = $1 AND reminder_type = $2 AND recipient_phone = $3`,
    [groupSessionId, type, phone, status, detail.slice(0, 300)]
  );
}

export async function processGroupSessionReminders(
  options: GroupReminderOptions
): Promise<GroupReminderStats> {
  await ensureReminderLog();

  const stats: GroupReminderStats = { sent: 0, failed: 0, skipped: 0, previewed: 0, preview: [] };
  const nowMs = Date.now() + (options.lookaheadMinutes ?? 0) * 60 * 1000;
  const horizon = new Date(nowMs + 48 * HOUR_MS);
  // Far enough back to catch any session whose thank-you is still in its window.
  const lookback = new Date(nowMs - 24 * HOUR_MS);

  const sessionsResult = await query(
    `SELECT id, title, session_date, session_date_end, location, price
     FROM group_sessions
     WHERE session_date > $1 AND session_date <= $2
       AND ($3::bigint IS NULL OR id = $3::bigint)
     ORDER BY session_date ASC`,
    [lookback.toISOString(), horizon.toISOString(), options.groupSessionId ?? null]
  );

  for (const session of sessionsResult.rows as UpcomingSession[]) {
    const sessionId = Number(session.id);
    const startMs = new Date(session.session_date).getTime();
    const roster = await getRoster(sessionId);
    const rosterNames = roster.map((row) => `${row.first_name} ${row.last_name}`.trim());

    const endMs = session.session_date_end
      ? new Date(session.session_date_end).getTime()
      : startMs + HOUR_MS;

    const jobs: Array<{ tier: Tier; recipient: Recipient; body: string }> = [];

    if (thankYouDue(endMs, nowMs)) {
      for (const recipient of familyRecipients(roster)) {
        jobs.push({ tier: THANK_YOU_TIER, recipient, body: buildThankYouSms(recipient.names) });
      }
    }

    const familyTier = activeTier(startMs, nowMs, 'family');
    if (familyTier) {
      for (const recipient of familyRecipients(roster)) {
        jobs.push({
          tier: familyTier,
          recipient,
          body: buildFamilyReminderSms(familyTier, session, recipient.names),
        });
      }
    }

    // A session with nobody on it doesn't need the coach texted about it.
    const coachTier = roster.length > 0 ? activeTier(startMs, nowMs, 'coach') : null;
    if (coachTier) {
      for (const recipient of await coachRecipients(sessionId)) {
        jobs.push({
          tier: coachTier,
          recipient,
          body: buildCoachReminderSms(coachTier, session, rosterNames),
        });
      }
    }

    for (const { tier, recipient, body } of jobs) {
      const to = options.overrideTo || recipient.phone;

      if (options.dryRun) {
        if (await alreadySent(sessionId, tier.type, recipient.phone)) {
          stats.skipped += 1;
          continue;
        }
        stats.previewed += 1;
        if (stats.preview.length < 25) {
          stats.preview.push({ groupSessionId: sessionId, reminderType: tier.type, to, body });
        }
        continue;
      }

      if (options.markSent && !(await claim(sessionId, tier.type, recipient.phone))) {
        stats.skipped += 1;
        continue;
      }

      try {
        const result = await sendSmsViaTwilio(to, body);
        if (result.ok) {
          stats.sent += 1;
          if (options.markSent) {
            await record(sessionId, tier.type, recipient.phone, 'sent', `sms-sent:${result.sid || 'ok'}`);
          }
        } else {
          stats.failed += 1;
          if (options.markSent) {
            await record(sessionId, tier.type, recipient.phone, 'failed', result.error || 'unknown');
          }
        }
      } catch (error) {
        stats.failed += 1;
        if (options.markSent) {
          const message = error instanceof Error ? error.message : 'Unknown SMS send exception';
          await record(sessionId, tier.type, recipient.phone, 'failed', message);
        }
      }
    }
  }

  return stats;
}
