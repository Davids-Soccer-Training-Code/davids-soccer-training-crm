import { query } from '@/lib/db';
import { jsonResponse, errorResponse } from '@/lib/api-helpers';
import { createSessionReminders } from '@/lib/reminders';
import { parseDatetimeLocalAsArizona } from '@/lib/timezone';
import {
  removeSessionFromGoogleCalendarsSafe,
  syncSessionToGoogleCalendarsSafe,
} from '@/lib/google-calendar';
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

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureSessionCalendarColumns();
    const { id } = await params;
    const result = await query('SELECT * FROM crm_sessions WHERE id = $1', [id]);
    if (result.rows.length === 0) return errorResponse('Session not found', 404);
    return jsonResponse(result.rows[0]);
  } catch (error) {
    console.error('Error fetching session:', error);
    return errorResponse('Failed to fetch session');
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensureSessionCalendarColumns();
    await ensureStaffTables();

    const { id } = await params;
    const body = await request.json();
    const shouldRefreshSessionReminders =
      (typeof body.session_date === 'string' && body.session_date.trim().length > 0) ||
      Object.prototype.hasOwnProperty.call(body, 'session_end_date');

    const existingResult = await query(
      `SELECT s.id, s.session_date, s.session_end_date, s.guest_emails, p.email as parent_email
       FROM crm_sessions s
       JOIN crm_parents p ON p.id = s.parent_id
       WHERE s.id = $1
       LIMIT 1`,
      [id]
    );
    if (existingResult.rows.length === 0) return errorResponse('Session not found', 404);
    const existing = existingResult.rows[0] as {
      session_date: string;
      session_end_date: string | null;
      guest_emails: string[] | null;
      parent_email: string | null;
    };

    if ('title' in body) {
      body.title = normalizeSessionTitle(body.title);
    }
    if ('send_email_updates' in body && typeof body.send_email_updates !== 'boolean') {
      return errorResponse('send_email_updates must be a boolean', 400);
    }
    if ('guest_emails' in body) {
      const { emails, invalid } = parseGuestEmails(body.guest_emails);
      if (invalid.length > 0) {
        return errorResponse(`Invalid guest email(s): ${invalid.join(', ')}`, 400);
      }
      body.guest_emails = ensureParentEmailInGuestList(emails, existing.parent_email);
    } else {
      const existingGuestEmails = Array.isArray(existing.guest_emails) ? existing.guest_emails : [];
      body.guest_emails = ensureParentEmailInGuestList(existingGuestEmails, existing.parent_email);
    }

    // Convert session_date from Arizona time to UTC if present
    if (body.session_date) {
      body.session_date = parseDatetimeLocalAsArizona(body.session_date);
    }
    if ('session_end_date' in body) {
      body.session_end_date = body.session_end_date
        ? parseDatetimeLocalAsArizona(body.session_end_date)
        : null;
    }

    const currentStartIso = new Date(existing.session_date).toISOString();
    const currentEndIso = existing.session_end_date
      ? new Date(existing.session_end_date).toISOString()
      : defaultSessionEndFromStart(currentStartIso);
    const nextStartIso = body.session_date || currentStartIso;
    let nextEndIso = body.session_end_date || currentEndIso;

    if (!('session_end_date' in body) && 'session_date' in body) {
      const durationMs = Math.max(
        15 * 60 * 1000,
        new Date(currentEndIso).getTime() - new Date(currentStartIso).getTime()
      );
      nextEndIso = new Date(new Date(nextStartIso).getTime() + durationMs).toISOString();
      body.session_end_date = nextEndIso;
    }

    if ('session_end_date' in body && body.session_end_date === null) {
      nextEndIso = defaultSessionEndFromStart(nextStartIso);
      body.session_end_date = nextEndIso;
    }

    if (!isEndAfterStart(nextStartIso, nextEndIso)) {
      return errorResponse('Session end time must be after start time', 400);
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    const allowedFields = [
      'session_date',
      'session_end_date',
      'title',
      'location',
      'price',
      'package_id',
      'notes',
      'guest_emails',
      'send_email_updates',
      'status',
      'cancelled',
      'showed_up',
      'was_paid',
      'payment_method',
      'coach_id',
    ];
    for (const field of allowedFields) {
      if (field in body) {
        fields.push(`${field} = $${paramIndex}`);
        values.push(body[field]);
        paramIndex++;
      }
    }

    if (fields.length === 0) return errorResponse('No fields to update', 400);

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const result = await query(
      `UPDATE crm_sessions SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );
    if (result.rows.length === 0) return errorResponse('Session not found', 404);

    const session = result.rows[0];
    if (
      shouldRefreshSessionReminders &&
      session.status !== 'completed' &&
      session.status !== 'cancelled' &&
      !session.cancelled
    ) {
      await query(
        `DELETE FROM crm_reminders
         WHERE session_id = $1
           AND reminder_category = 'session_reminder'
           AND sent = false`,
        [session.id]
      );

      await createSessionReminders(session.parent_id, session.session_date, {
        sessionId: session.id,
        sessionEndDate: session.session_end_date,
      });
    }

    await syncSessionToGoogleCalendarsSafe(session.id, 'session patch');

    return jsonResponse(session);
  } catch (error) {
    console.error('Error updating session:', error);
    return errorResponse('Failed to update session');
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await removeSessionFromGoogleCalendarsSafe(id, 'session delete');
    const result = await query('DELETE FROM crm_sessions WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return errorResponse('Session not found', 404);
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error('Error deleting session:', error);
    return errorResponse('Failed to delete session');
  }
}
