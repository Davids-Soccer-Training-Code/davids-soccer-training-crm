import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { jsonResponse, errorResponse } from '@/lib/api-helpers';
import {
  removeGroupSessionFromGoogleCalendarsSafe,
  syncGroupSessionToGoogleCalendarsSafe,
} from '@/lib/google-calendar';
import { parseDatetimeLocalAsArizona } from '@/lib/timezone';

export const dynamic = 'force-dynamic';

interface GroupSessionRow {
  id: number;
  title: string;
  description: string | null;
  image_url: string | null;
  session_date: string;
  session_date_end: string | null;
  location: string | null;
  price: string | number | null;
  curriculum: string | null;
  max_players: number;
  player_count: number;
  prospect_count: number;
  total_paid_amount: string | number;
  created_at: string;
  updated_at: string;
}

function asNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function mapGroupSession(row: GroupSessionRow) {
  return {
    ...row,
    session_date: normalizeToUtcIso(row.session_date) ?? row.session_date,
    session_date_end: normalizeToUtcIso(row.session_date_end),
    price: row.price == null ? null : round2(asNumber(row.price)),
    max_players: asNumber(row.max_players),
    player_count: asNumber(row.player_count),
    prospect_count: asNumber(row.prospect_count),
    total_paid_amount: round2(asNumber(row.total_paid_amount)),
  };
}

function normalizeToUtcIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const s = String(value).trim();
  if (!s) return null;
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/.test(s);
  const asUtc = hasTimezone ? s : `${s.replace(' ', 'T')}Z`;
  const d = new Date(asUtc);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeOptionalText(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeSessionDateInput(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;

  const trimmed = value.trim();
  const hasTimezone = /(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed);

  if (!hasTimezone) {
    const localValue = trimmed.length === 10 ? `${trimmed}T00:00` : trimmed.replace(' ', 'T');
    return parseDatetimeLocalAsArizona(localValue);
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

async function getGroupSession(id: string) {
  const result = await query(
    `SELECT
      gs.*,
      COUNT(ps.id) FILTER (WHERE ps.has_paid = true)::int AS player_count,
      COUNT(ps.id) FILTER (WHERE COALESCE(ps.has_paid, false) = false)::int AS prospect_count,
      COALESCE(SUM(COALESCE(ps.amount_paid, ps.signup_price)) FILTER (WHERE ps.has_paid = true), 0)::numeric AS total_paid_amount
    FROM group_sessions gs
    LEFT JOIN player_signups ps ON ps.group_session_id = gs.id
    WHERE gs.id = $1
    GROUP BY gs.id`,
    [id]
  );

  if (result.rows.length === 0) return null;
  return mapGroupSession(result.rows[0] as GroupSessionRow);
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const groupSession = await getGroupSession(id);

    if (!groupSession) return errorResponse('Group session not found', 404);
    return jsonResponse(groupSession);
  } catch (error) {
    console.error('Error fetching group session:', error);
    return errorResponse('Failed to fetch group session');
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const sessionDateUpdates: { session_date?: string; session_date_end?: string | null } = {};

    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if ('title' in body) {
      const title = normalizeOptionalText(body.title);
      if (!title) return errorResponse('Title is required', 400);
      fields.push(`title = $${paramIndex++}`);
      values.push(title);
    }

    if ('description' in body) {
      fields.push(`description = $${paramIndex++}`);
      values.push(normalizeOptionalText(body.description));
    }

    if ('image_url' in body) {
      const imageUrl = normalizeOptionalText(body.image_url);
      if (!imageUrl) return errorResponse('Image URL is required', 400);
      fields.push(`image_url = $${paramIndex++}`);
      values.push(imageUrl);
    }

    if ('session_date' in body) {
      const sessionDate = normalizeSessionDateInput(body.session_date);
      if (!sessionDate) return errorResponse('Session date is invalid', 400);
      sessionDateUpdates.session_date = sessionDate;
      fields.push(`session_date = $${paramIndex++}`);
      values.push(sessionDate);
    }

    if ('session_date_end' in body) {
      const sessionDateEnd = normalizeSessionDateInput(body.session_date_end);
      sessionDateUpdates.session_date_end = sessionDateEnd;
      fields.push(`session_date_end = $${paramIndex++}`);
      values.push(sessionDateEnd);
    }

    if ('location' in body) {
      const location = normalizeOptionalText(body.location);
      if (!location) return errorResponse('Location is required', 400);
      fields.push(`location = $${paramIndex++}`);
      values.push(location);
    }

    if ('price' in body) {
      const price = body.price == null || String(body.price).trim() === '' ? null : Number(body.price);
      if (price != null && !Number.isFinite(price)) {
        return errorResponse('Price must be a valid number', 400);
      }
      fields.push(`price = $${paramIndex++}`);
      values.push(price);
    }

    if ('curriculum' in body) {
      fields.push(`curriculum = $${paramIndex++}`);
      values.push(normalizeOptionalText(body.curriculum));
    }

    if ('max_players' in body) {
      const maxPlayers = Number(body.max_players);
      if (!Number.isInteger(maxPlayers) || maxPlayers < 1) {
        return errorResponse('Max players must be at least 1', 400);
      }

      const countResult = await query(
        `SELECT COUNT(*)::int AS player_count
         FROM player_signups
         WHERE group_session_id = $1
           AND has_paid = true`,
        [id]
      );

      const playerCount = asNumber(countResult.rows[0]?.player_count);
      if (maxPlayers < playerCount) {
        return errorResponse('Max players cannot be less than current signups', 400);
      }

      fields.push(`max_players = $${paramIndex++}`);
      values.push(maxPlayers);
    }

    if (fields.length === 0) {
      return errorResponse('No fields to update', 400);
    }

    if ('session_date' in sessionDateUpdates || 'session_date_end' in sessionDateUpdates) {
      const existingResult = await query(
        `SELECT session_date, session_date_end
         FROM group_sessions
         WHERE id = $1`,
        [id]
      );

      if (existingResult.rows.length === 0) {
        return errorResponse('Group session not found', 404);
      }

      const existing = existingResult.rows[0] as {
        session_date: string;
        session_date_end: string | null;
      };

      const effectiveStart = sessionDateUpdates.session_date ?? existing.session_date;
      const effectiveEnd =
        sessionDateUpdates.session_date_end !== undefined
          ? sessionDateUpdates.session_date_end
          : existing.session_date_end;

      if (effectiveEnd && new Date(effectiveEnd) < new Date(effectiveStart)) {
        return errorResponse('End date must be after start date', 400);
      }
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const result = await query(
      `UPDATE group_sessions
       SET ${fields.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING id`,
      values
    );

    if (result.rows.length === 0) return errorResponse('Group session not found', 404);

    await syncGroupSessionToGoogleCalendarsSafe(id, 'group session update');

    const groupSession = await getGroupSession(id);
    return jsonResponse(groupSession);
  } catch (error) {
    console.error('Error updating group session:', error);
    return errorResponse('Failed to update group session');
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await removeGroupSessionFromGoogleCalendarsSafe(id, 'group session delete');
    const result = await query('DELETE FROM group_sessions WHERE id = $1 RETURNING id', [id]);

    if (result.rows.length === 0) return errorResponse('Group session not found', 404);
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error('Error deleting group session:', error);
    return errorResponse('Failed to delete group session');
  }
}
