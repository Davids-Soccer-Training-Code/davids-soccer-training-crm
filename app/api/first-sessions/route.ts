import { query } from '@/lib/db';
import { jsonResponse, errorResponse } from '@/lib/api-helpers';
import { createSessionReminders } from '@/lib/reminders';
import { parseDatetimeLocalAsArizona } from '@/lib/timezone';
import { syncFirstSessionToGoogleCalendarsSafe } from '@/lib/google-calendar';
import {
  defaultFirstSessionEndFromStart,
  ensureFirstSessionCalendarColumns,
} from '@/lib/first-session-calendar-fields';
import {
  ensureParentEmailInGuestList,
  isEndAfterStart,
  normalizeSessionTitle,
  parseGuestEmails,
} from '@/lib/session-calendar-fields';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await ensureFirstSessionCalendarColumns();

    const result = await query(`
      SELECT fs.*, p.name as parent_name, p.email as parent_email, st.name as coach_name,
        ARRAY_AGG(pl.name) FILTER (WHERE pl.name IS NOT NULL) as player_names,
        ARRAY_AGG(pl.id) FILTER (WHERE pl.id IS NOT NULL) as player_ids
      FROM crm_first_sessions fs
      JOIN crm_parents p ON p.id = fs.parent_id
      LEFT JOIN crm_staff st ON st.id = fs.coach_id
      LEFT JOIN crm_first_session_players fsp ON fsp.first_session_id = fs.id
      LEFT JOIN crm_players pl ON pl.id = fsp.player_id
      GROUP BY fs.id, p.name, p.email, st.name
      ORDER BY fs.session_date DESC
    `);
    return jsonResponse(result.rows);
  } catch (error) {
    console.error('Error fetching first sessions:', error);
    return errorResponse('Failed to fetch first sessions');
  }
}

export async function POST(request: NextRequest) {
  try {
    await ensureFirstSessionCalendarColumns();

    const body = await request.json();
    const {
      parent_id,
      player_ids,
      session_date,
      session_end_date,
      location,
      price,
      deposit_paid,
      deposit_amount,
      notes,
    } = body;

    if (!parent_id || !session_date) {
      return errorResponse('Parent and session date are required', 400);
    }
    if ('send_email_updates' in body && typeof body.send_email_updates !== 'boolean') {
      return errorResponse('send_email_updates must be a boolean', 400);
    }

    const normalizedTitle = normalizeSessionTitle(body.title);
    const sendEmailUpdates = body.send_email_updates === true;

    const parentResult = await query(`SELECT id, email FROM crm_parents WHERE id = $1 LIMIT 1`, [parent_id]);
    if (parentResult.rows.length === 0) {
      return errorResponse('Parent not found', 404);
    }
    const parentEmail = parentResult.rows[0].email as string | null;

    const { emails: parsedGuestEmails, invalid: invalidGuestEmails } = parseGuestEmails(body.guest_emails);
    if (invalidGuestEmails.length > 0) {
      return errorResponse(`Invalid guest email(s): ${invalidGuestEmails.join(', ')}`, 400);
    }
    const guestEmails = ensureParentEmailInGuestList(parsedGuestEmails, parentEmail);

    // Convert datetime-local input (Arizona time) to UTC ISO string for storage
    const sessionDateUTC = parseDatetimeLocalAsArizona(session_date);
    const sessionEndDateUTC = session_end_date
      ? parseDatetimeLocalAsArizona(session_end_date)
      : defaultFirstSessionEndFromStart(sessionDateUTC);

    if (!isEndAfterStart(sessionDateUTC, sessionEndDateUTC)) {
      return errorResponse('Session end time must be after start time', 400);
    }

    const result = await query(
      `INSERT INTO crm_first_sessions
         (parent_id, title, session_date, session_end_date, location, price, deposit_paid, deposit_amount, notes, guest_emails, send_email_updates)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        parent_id,
        normalizedTitle,
        sessionDateUTC,
        sessionEndDateUTC,
        location || null,
        price || null,
        deposit_paid || false,
        deposit_amount || null,
        notes || null,
        guestEmails,
        sendEmailUpdates,
      ]
    );

    const session = result.rows[0];

    // Add players to junction table if provided
    if (player_ids && Array.isArray(player_ids) && player_ids.length > 0) {
      for (const playerId of player_ids) {
        await query(
          `INSERT INTO crm_first_session_players (first_session_id, player_id) VALUES ($1, $2)`,
          [session.id, playerId]
        );
      }
    }

    // Update parent to be a customer and set call_outcome to session_booked
    await query(
      `UPDATE crm_parents SET is_customer = TRUE, call_outcome = 'session_booked', last_activity_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [parent_id]
    );

    // Create 48h, 24h, 6h reminders (use the UTC date)
    await createSessionReminders(parent_id, sessionDateUTC, {
      firstSessionId: session.id,
      sessionEndDate: sessionEndDateUTC,
    });

    await syncFirstSessionToGoogleCalendarsSafe(session.id, 'first session create');

    return jsonResponse(session, 201);
  } catch (error) {
    console.error('Error creating first session:', error);
    return errorResponse('Failed to create first session');
  }
}
