/**
 * Coaches on a group training.
 *
 * A group session can have more than one coach (a lead and an assistant), so
 * this is a join table rather than a `coach_id` column like private sessions
 * carry. Coaches live in the shared `crm_staff` table, so a coach added in
 * either app can be put on a group session here.
 *
 * Newly assigned coaches are texted the session details. Like every other send
 * in this app it is best-effort: a coach with no phone on file, or a Twilio
 * failure, never fails the save that triggered it.
 */
import { query } from '@/lib/db';
import { ensureStaffTables } from '@/app/api/staff/route';
import { normalizeUsPhoneNumber, sendSmsViaTwilio } from '@/lib/twilio';
import { formatSessionWhen, getGroupSessionDetails } from '@/lib/group-session-notifications';

export interface GroupSessionCoach {
  id: number;
  name: string;
}

let ensurePromise: Promise<void> | null = null;

/** Self-heals the schema on first touch, like the other `ensure*` helpers. */
export async function ensureGroupSessionCoachTables(): Promise<void> {
  if (ensurePromise) {
    await ensurePromise;
    return;
  }

  ensurePromise = (async () => {
    await ensureStaffTables();
    await query(`
      CREATE TABLE IF NOT EXISTS group_session_coaches (
        group_session_id BIGINT NOT NULL REFERENCES group_sessions(id) ON DELETE CASCADE,
        staff_id INTEGER NOT NULL REFERENCES crm_staff(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_session_id, staff_id)
      )
    `);
  })().catch((error) => {
    ensurePromise = null;
    throw error;
  });

  await ensurePromise;
}

/** Normalizes whatever the client sent into a clean list of staff ids. */
export function parseCoachIds(input: unknown): number[] {
  if (!Array.isArray(input)) return [];
  const ids = input
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  return [...new Set(ids)];
}

/** Coaches for each of the given sessions, keyed by session id. */
export async function getCoachesForGroupSessions(
  groupSessionIds: Array<string | number>
): Promise<Map<number, GroupSessionCoach[]>> {
  await ensureGroupSessionCoachTables();
  const byId = new Map<number, GroupSessionCoach[]>();
  if (groupSessionIds.length === 0) return byId;

  const result = await query(
    `SELECT gsc.group_session_id, st.id, st.name
     FROM group_session_coaches gsc
     JOIN crm_staff st ON st.id = gsc.staff_id
     WHERE gsc.group_session_id = ANY($1::bigint[])
     ORDER BY st.name ASC`,
    [groupSessionIds.map(Number)]
  );

  for (const row of result.rows as Array<{ group_session_id: string | number; id: number; name: string }>) {
    const key = Number(row.group_session_id);
    const list = byId.get(key) ?? [];
    list.push({ id: Number(row.id), name: row.name });
    byId.set(key, list);
  }

  return byId;
}

/**
 * Replaces a session's coach list and returns the ids that were not on it
 * before -- the ones who should be told they've been assigned.
 */
export async function setGroupSessionCoaches(
  groupSessionId: string | number,
  coachIds: number[]
): Promise<number[]> {
  await ensureGroupSessionCoachTables();

  const existing = await query(
    'SELECT staff_id FROM group_session_coaches WHERE group_session_id = $1',
    [groupSessionId]
  );
  const before = new Set(
    (existing.rows as Array<{ staff_id: number }>).map((row) => Number(row.staff_id))
  );

  await query(
    `DELETE FROM group_session_coaches
     WHERE group_session_id = $1 AND NOT (staff_id = ANY($2::int[]))`,
    [groupSessionId, coachIds]
  );

  if (coachIds.length > 0) {
    // Only ids that exist in crm_staff are inserted, so a stale id from the
    // client is dropped rather than failing the whole save on the FK.
    await query(
      `INSERT INTO group_session_coaches (group_session_id, staff_id)
       SELECT $1, st.id FROM crm_staff st WHERE st.id = ANY($2::int[])
       ON CONFLICT DO NOTHING`,
      [groupSessionId, coachIds]
    );
  }

  return coachIds.filter((id) => !before.has(id));
}

export function buildCoachAssignmentSms(
  session: { title: string; location: string | null },
  when: string,
  rosterCount: number
): string {
  const lines = [`⚽ You've been assigned to coach ${session.title}.`, when];
  if (session.location) lines.push(session.location);
  lines.push(`${rosterCount} player${rosterCount === 1 ? '' : 's'} signed up so far.`);
  lines.push("- David's Soccer Training");
  return lines.join('\n');
}

/** Texts each newly assigned coach. Never throws. */
export async function notifyGroupSessionCoaches(
  groupSessionId: string | number,
  coachIds: number[]
): Promise<void> {
  if (coachIds.length === 0) return;

  try {
    const session = await getGroupSessionDetails(groupSessionId);
    if (!session) return;

    const countResult = await query(
      'SELECT COUNT(*)::int AS n FROM player_signups WHERE group_session_id = $1',
      [groupSessionId]
    );
    const body = buildCoachAssignmentSms(
      session,
      formatSessionWhen(session),
      Number(countResult.rows[0]?.n ?? 0)
    );

    const coaches = await query('SELECT id, name, phone FROM crm_staff WHERE id = ANY($1::int[])', [
      coachIds,
    ]);

    for (const coach of coaches.rows as Array<{ id: number; name: string; phone: string | null }>) {
      const phone = normalizeUsPhoneNumber(coach.phone);
      if (!phone) continue;

      if (process.env.COACH_SMS_DRY_RUN === 'true') {
        console.log(`[COACH_SMS_DRY_RUN] -> ${phone} (${coach.name}): ${body}`);
        continue;
      }

      const result = await sendSmsViaTwilio(phone, body);
      if (!result.ok) {
        console.error(
          `Group coach assignment SMS failed for coach ${coach.id} (group #${groupSessionId}): ${result.error}`
        );
      }
    }
  } catch (error) {
    console.error('notifyGroupSessionCoaches error:', error);
  }
}
