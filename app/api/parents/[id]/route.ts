import { query } from '@/lib/db';
import { jsonResponse, errorResponse } from '@/lib/api-helpers';
import { createFollowUpReminders } from '@/lib/reminders';
import { parseDateAsArizona, parseDatetimeLocalAsArizona } from '@/lib/timezone';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

function normalizeCallDateTimeInput(value: unknown): unknown {
  if (typeof value !== 'string' || value.trim().length === 0) return value;

  const normalized = value.trim();
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/.test(normalized);

  if (normalized.length === 10) {
    return parseDateAsArizona(normalized);
  }

  if (!hasTimezone) {
    return parseDatetimeLocalAsArizona(normalized.replace(' ', 'T'));
  }

  return normalized;
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const parentResult = await query('SELECT * FROM crm_parents WHERE id = $1', [id]);
    if (parentResult.rows.length === 0) {
      return errorResponse('Contact not found', 404);
    }

    const playersResult = await query('SELECT * FROM crm_players WHERE parent_id = $1 ORDER BY created_at', [id]);
    const firstSessionResult = await query(
      `SELECT fs.*, st.name AS coach_name
         FROM crm_first_sessions fs
         LEFT JOIN crm_staff st ON st.id = fs.coach_id
        WHERE fs.parent_id = $1 ORDER BY fs.session_date DESC`,
      [id]
    );
    const sessionsResult = await query(
      `SELECT s.*, st.name AS coach_name
         FROM crm_sessions s
         LEFT JOIN crm_staff st ON st.id = s.coach_id
        WHERE s.parent_id = $1 ORDER BY s.session_date DESC`,
      [id]
    );
    const packagesResult = await query(
      `SELECT
         pkg.id,
         pkg.parent_id,
         pkg.package_type,
         pkg.total_sessions,
         COALESCE((
           SELECT COUNT(*)
           FROM crm_sessions s
           WHERE s.package_id = pkg.id
             AND COALESCE(s.cancelled, false) = false
             AND COALESCE(s.status, '') NOT IN ('cancelled', 'no_show')
             AND (
               s.showed_up = true
               OR s.status = 'completed'
               OR (s.status = 'accepted' AND s.session_date <= NOW())
             )
         ), 0) as sessions_completed,
         pkg.price,
         pkg.amount_received,
         pkg.start_date,
         pkg.is_active,
         pkg.created_at,
         pkg.updated_at
       FROM crm_packages pkg
       WHERE pkg.parent_id = $1
         AND pkg.is_active = true
       ORDER BY pkg.created_at DESC
       LIMIT 1`,
      [id]
    );
    const remindersResult = await query(
      'SELECT * FROM crm_reminders WHERE parent_id = $1 AND sent = false ORDER BY due_at',
      [id]
    );

    return jsonResponse({
      ...parentResult.rows[0],
      players: playersResult.rows,
      first_session: firstSessionResult.rows[0] || null,
      first_sessions: firstSessionResult.rows,
      sessions: sessionsResult.rows,
      active_package: packagesResult.rows[0] || null,
      pending_reminders: remindersResult.rows,
    });
  } catch (error) {
    console.error('Error fetching parent:', error);
    return errorResponse('Failed to fetch contact');
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const parentId = Number(id);
    const body = await request.json();

    // Check if parent exists
    const existing = await query('SELECT * FROM crm_parents WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return errorResponse('Contact not found', 404);
    }

    const oldParent = existing.rows[0];

    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    // Normalize date-only/datetime call values as Arizona local time.
    if ('call_date_time' in body && body.call_date_time) {
      body.call_date_time = normalizeCallDateTimeInput(body.call_date_time);
    }

    const allowedFields = [
      'name', 'email', 'phone', 'instagram_link', 'secondary_parent_name',
      'dm_status', 'phone_call_booked', 'call_date_time', 'call_outcome',
      'interest_in_package', 'notes', 'is_dead'
    ];

    for (const field of allowedFields) {
      if (field in body) {
        if (field === 'call_date_time' && body[field] !== null) {
          fields.push(`${field} = ($${paramIndex}::timestamptz AT TIME ZONE 'UTC')`);
        } else {
          fields.push(`${field} = $${paramIndex}`);
        }
        values.push(body[field]);
        paramIndex++;
      }
    }

    if (fields.length === 0) {
      return errorResponse('No fields to update', 400);
    }

    // Track activity on any status change
    const activityFields = ['dm_status', 'phone_call_booked', 'call_outcome', 'interest_in_package'];
    const hasActivityChange = activityFields.some(field => field in body);
    
    if (hasActivityChange) {
      fields.push(`last_activity_at = CURRENT_TIMESTAMP`);
    }

    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    const result = await query(
      `UPDATE crm_parents SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    // Auto-create/cancel follow-up reminders based on status changes
    const newParent = result.rows[0];

    // DM status changed — at ANY stage they could stop replying
    // So every DM status change: clear old follow-ups, create fresh ones
    if (body.dm_status && body.dm_status !== oldParent.dm_status) {
      // Clear any existing unsent DM follow-ups first (avoid duplicates)
      await query(
        `DELETE FROM crm_reminders WHERE parent_id = $1 AND reminder_category = 'dm_follow_up' AND sent = false`,
        [id]
      );
      // Create fresh 1/3/7/14 day follow-ups from now
      // (covers: first message no reply, started talking then ghosted, asked for call then ghosted, went cold)
      await createFollowUpReminders(parentId, 'dm_follow_up');
    }

    // Phone call booked — they've moved past DMs, cancel DM follow-ups
    if (body.phone_call_booked === true && !oldParent.phone_call_booked) {
      await query(
        `DELETE FROM crm_reminders WHERE parent_id = $1 AND reminder_category = 'dm_follow_up' AND sent = false`,
        [id]
      );
    }

    const callOutcomeChanged =
      'call_outcome' in body && body.call_outcome !== oldParent.call_outcome;
    const callDateChanged = 'call_date_time' in body;
    const phoneCallBookedChanged =
      'phone_call_booked' in body && body.phone_call_booked !== oldParent.phone_call_booked;
    const shouldResyncPostCallFollowUps =
      callOutcomeChanged || callDateChanged || phoneCallBookedChanged;
    const shouldHavePostCallFollowUps =
      newParent.phone_call_booked === true &&
      (!newParent.call_outcome ||
        newParent.call_outcome === 'thinking_about_it' ||
        newParent.call_outcome === 'went_cold');

    if (shouldResyncPostCallFollowUps) {
      await query(
        `DELETE FROM crm_reminders WHERE parent_id = $1 AND reminder_category = 'post_call_follow_up' AND sent = false`,
        [id]
      );

      if (shouldHavePostCallFollowUps) {
        await createFollowUpReminders(parentId, 'post_call_follow_up', {
          anchorDate: newParent.call_date_time || new Date(),
          anchorTimezone: 'arizona_local',
        });
      }
    }

    if (newParent.is_dead === true && oldParent.is_dead !== true) {
      await query(
        `DELETE FROM crm_reminders WHERE parent_id = $1 AND sent = false`,
        [id]
      );
    }

    return jsonResponse(newParent);
  } catch (error) {
    console.error('Error updating parent:', error);
    return errorResponse('Failed to update contact');
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await query('DELETE FROM crm_parents WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) {
      return errorResponse('Contact not found', 404);
    }
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error('Error deleting parent:', error);
    return errorResponse('Failed to delete contact');
  }
}
