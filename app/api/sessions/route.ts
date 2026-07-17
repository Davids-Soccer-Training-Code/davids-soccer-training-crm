import { query } from '@/lib/db';
import { jsonResponse, errorResponse } from '@/lib/api-helpers';
import { createSessionReminders } from '@/lib/reminders';
import { parseDatetimeLocalAsArizona } from '@/lib/timezone';
import { syncSessionToGoogleCalendarsSafe } from '@/lib/google-calendar';
import {
  defaultSessionEndFromStart,
  ensureParentEmailInGuestList,
  ensureSessionCalendarColumns,
  isEndAfterStart,
  normalizeSessionTitle,
  parseGuestEmails,
} from '@/lib/session-calendar-fields';
import { ensureStaffTables } from '@/app/api/staff/route';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    await ensureSessionCalendarColumns();

    const searchParams = request.nextUrl.searchParams;
    const parentId = searchParams.get('parent_id');
    const upcoming = searchParams.get('upcoming');

    let sql = `
      SELECT s.*, p.name as parent_name, p.email as parent_email,
        ARRAY_AGG(pl.name) FILTER (WHERE pl.name IS NOT NULL) as player_names,
        ARRAY_AGG(pl.id) FILTER (WHERE pl.id IS NOT NULL) as player_ids
      FROM crm_sessions s
      JOIN crm_parents p ON p.id = s.parent_id
      LEFT JOIN crm_session_players sp ON sp.session_id = s.id
      LEFT JOIN crm_players pl ON pl.id = sp.player_id
    `;
    const params: string[] = [];

    if (parentId) {
      params.push(parentId);
      sql += ` WHERE s.parent_id = $${params.length}`;
    }

    if (upcoming === 'true') {
      sql += params.length ? ' AND' : ' WHERE';
      sql += ' s.session_date >= NOW() AND s.cancelled = false';
    }

    sql += ' GROUP BY s.id, p.name, p.email ORDER BY s.session_date DESC';

    const result = await query(sql, params);
    return jsonResponse(result.rows);
  } catch (error) {
    console.error('Error fetching sessions:', error);
    return errorResponse('Failed to fetch sessions');
  }
}

export async function POST(request: NextRequest) {
  try {
    await ensureSessionCalendarColumns();
    await ensureStaffTables();

    const body = await request.json();
    const {
      parent_id,
      player_ids,
      session_date,
      session_end_date,
      location,
      price,
      package_id,
      notes,
      coach_id,
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

    const sessionDateUTC = parseDatetimeLocalAsArizona(session_date);
    const sessionEndDateUTC = session_end_date
      ? parseDatetimeLocalAsArizona(session_end_date)
      : defaultSessionEndFromStart(sessionDateUTC);

    if (!isEndAfterStart(sessionDateUTC, sessionEndDateUTC)) {
      return errorResponse('Session end time must be after start time', 400);
    }

    const result = await query(
      `INSERT INTO crm_sessions (parent_id, title, session_date, session_end_date, location, price, package_id, notes, guest_emails, send_email_updates, coach_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        parent_id,
        normalizedTitle,
        sessionDateUTC,
        sessionEndDateUTC,
        location || null,
        price || null,
        package_id || null,
        notes || null,
        guestEmails,
        sendEmailUpdates,
        coach_id || null,
      ]
    );

    const session = result.rows[0];

    // Add players to junction table if provided
    if (player_ids && Array.isArray(player_ids) && player_ids.length > 0) {
      for (const playerId of player_ids) {
        await query(
          `INSERT INTO crm_session_players (session_id, player_id) VALUES ($1, $2)`,
          [session.id, playerId]
        );
      }
    }

    // Create 48h, 24h, 6h reminders (use the UTC date)
    await createSessionReminders(parent_id, sessionDateUTC, {
      sessionId: session.id,
      sessionEndDate: sessionEndDateUTC,
    });

    // Update parent's last activity timestamp
    await query(
      `UPDATE crm_parents SET last_activity_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [parent_id]
    );

    // New session booked — cancel any pending drop-off follow-ups (they're back!)
    await query(
      `DELETE FROM crm_reminders WHERE parent_id = $1 AND reminder_category IN ('post_session_follow_up', 'post_first_session_follow_up') AND sent = false`,
      [parent_id]
    );

    await syncSessionToGoogleCalendarsSafe(session.id, 'session create');

    return jsonResponse(session, 201);
  } catch (error) {
    console.error('Error creating session:', error);
    return errorResponse('Failed to create session');
  }
}
