import { query } from '@/lib/db';
import { sendSmsViaTwilio, normalizeUsPhoneNumber } from '@/lib/twilio';
import { formatArizonaDateTime } from '@/lib/timezone';

export type CoachNotifyKind = 'session' | 'first';

/** Build the SMS body for a coach assignment. Pure — no I/O, easy to test. */
export function buildCoachAssignmentMessage(
  kind: CoachNotifyKind,
  detail: { parent_name: string; player_names: string[]; session_date: string; location: string | null }
): string {
  const players = detail.player_names.filter(Boolean);
  const subject = players.length > 0 ? players.join(', ') : detail.parent_name;
  const parentPart = players.length > 0 ? ` (parent ${detail.parent_name})` : '';
  const kindLabel = kind === 'first' ? 'first session' : 'session';
  const when = formatArizonaDateTime(detail.session_date);
  const location = detail.location || 'location TBD';
  return `⚽ You've been assigned a ${kindLabel}: ${subject}${parentPart} — ${when} at ${location}. — David's Soccer Training`;
}

/**
 * Text a coach that they've been assigned a (first) session. Fired when a
 * session is created with a coach or when a coach is newly assigned/changed on
 * an existing one. Best-effort: it never throws and silently skips when the
 * coach has no valid phone number on file, so it can't break the request that
 * triggered it.
 */
export async function notifyCoachOfAssignment(
  kind: CoachNotifyKind,
  sessionId: number,
  coachId: number | null | undefined
): Promise<void> {
  try {
    if (coachId == null) return;

    const coachRes = await query(
      'SELECT name, phone FROM crm_staff WHERE id = $1 LIMIT 1',
      [coachId]
    );
    const coach = coachRes.rows[0] as { name: string; phone: string | null } | undefined;
    if (!coach) return;

    const phone = normalizeUsPhoneNumber(coach.phone);
    if (!phone) return; // No valid phone — skip silently.

    const detailSql =
      kind === 'first'
        ? `SELECT fs.session_date, fs.location, p.name AS parent_name,
              ARRAY_AGG(pl.name) FILTER (WHERE pl.name IS NOT NULL) AS player_names
           FROM crm_first_sessions fs
           JOIN crm_parents p ON p.id = fs.parent_id
           LEFT JOIN crm_first_session_players fsp ON fsp.first_session_id = fs.id
           LEFT JOIN crm_players pl ON pl.id = fsp.player_id
           WHERE fs.id = $1
           GROUP BY fs.session_date, fs.location, p.name`
        : `SELECT s.session_date, s.location, p.name AS parent_name,
              ARRAY_AGG(pl.name) FILTER (WHERE pl.name IS NOT NULL) AS player_names
           FROM crm_sessions s
           JOIN crm_parents p ON p.id = s.parent_id
           LEFT JOIN crm_session_players sp ON sp.session_id = s.id
           LEFT JOIN crm_players pl ON pl.id = sp.player_id
           WHERE s.id = $1
           GROUP BY s.session_date, s.location, p.name`;

    const detailRes = await query(detailSql, [sessionId]);
    const detail = detailRes.rows[0] as
      | { session_date: string; location: string | null; parent_name: string; player_names: string[] | null }
      | undefined;
    if (!detail) return;

    const body = buildCoachAssignmentMessage(kind, {
      parent_name: detail.parent_name,
      player_names: Array.isArray(detail.player_names) ? detail.player_names : [],
      session_date: detail.session_date,
      location: detail.location,
    });

    // Escape hatch for local testing: log instead of sending a real text.
    if (process.env.COACH_SMS_DRY_RUN === 'true') {
      console.log(`[COACH_SMS_DRY_RUN] -> ${phone} (${coach.name}): ${body}`);
      return;
    }

    const result = await sendSmsViaTwilio(phone, body);
    if (!result.ok) {
      console.error(
        `Coach assignment SMS failed for coach ${coachId} (${kind} #${sessionId}): ${result.error}`
      );
    }
  } catch (error) {
    console.error('notifyCoachOfAssignment error:', error);
  }
}
