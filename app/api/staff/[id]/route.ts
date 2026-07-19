import { NextRequest } from 'next/server';
import { query, getClient } from '@/lib/db';
import { jsonResponse, errorResponse } from '@/lib/api-helpers';
import { ensureStaffTables } from '../route';

export const dynamic = 'force-dynamic';

const STAFF_COLUMNS =
  'id, name, email, phone, role, preferred_location, player_ages, player_notes, description, preferred_days, preferred_times, is_owner, created_at, updated_at';

const EDITABLE_FIELDS = [
  'name', 'email', 'phone', 'role', 'preferred_location',
  'player_ages', 'player_notes', 'description', 'preferred_days', 'preferred_times',
] as const;

async function loadStaff(id: number) {
  const result = await query(
    `
    SELECT ${STAFF_COLUMNS.split(', ').map((c) => `s.${c}`).join(', ')},
      COALESCE(
        JSON_AGG(
          JSON_BUILD_OBJECT('id', pl.id, 'name', pl.name, 'parent_name', par.name)
          ORDER BY pl.name
        ) FILTER (WHERE pl.id IS NOT NULL),
        '[]'
      ) AS players
    FROM crm_staff s
    LEFT JOIN crm_players pl ON pl.coach_id = s.id
    LEFT JOIN crm_parents par ON par.id = pl.parent_id
    WHERE s.id = $1
    GROUP BY s.id
  `,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: idStr } = await params;
  const id = parseInt(idStr);
  if (isNaN(id)) return errorResponse('Invalid ID', 400);
  try {
    await ensureStaffTables();
    const staff = await loadStaff(id);
    if (!staff) return errorResponse('Coach not found', 404);
    return jsonResponse(staff);
  } catch (error) {
    console.error('Error fetching staff member:', error);
    return errorResponse('Failed to fetch staff member');
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: idStr } = await params;
  const id = parseInt(idStr);
  if (isNaN(id)) return errorResponse('Invalid ID', 400);

  const client = await getClient();
  try {
    await ensureStaffTables();
    const body = (await request.json()) as Record<string, unknown> & { player_ids?: number[] };

    if ('name' in body && (typeof body.name !== 'string' || !body.name.trim())) {
      return errorResponse('Coach name cannot be empty', 400);
    }

    await client.query('BEGIN');

    const exists = await client.query('SELECT id FROM crm_staff WHERE id = $1', [id]);
    if (exists.rows.length === 0) {
      await client.query('ROLLBACK');
      return errorResponse('Coach not found', 404);
    }

    const setClauses: string[] = [];
    const values: unknown[] = [];
    for (const field of EDITABLE_FIELDS) {
      if (field in body) {
        values.push(typeof body[field] === 'string' ? (body[field] as string).trim() || null : null);
        setClauses.push(`${field} = $${values.length}`);
      }
    }
    if ('is_owner' in body) {
      values.push(body.is_owner === true);
      setClauses.push(`is_owner = $${values.length}`);
    }
    if (setClauses.length > 0) {
      values.push(id);
      await client.query(
        `UPDATE crm_staff SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`,
        values
      );
    }

    if (Array.isArray(body.player_ids)) {
      // Clear players that were assigned to this coach but are no longer listed.
      await client.query(
        `UPDATE crm_players SET coach_id = NULL WHERE coach_id = $1 AND NOT (id = ANY($2::int[]))`,
        [id, body.player_ids]
      );
      // Assign (moving from any other coach) the listed players.
      if (body.player_ids.length > 0) {
        await client.query(
          `UPDATE crm_players SET coach_id = $1 WHERE id = ANY($2::int[])`,
          [id, body.player_ids]
        );
      }
    }

    await client.query('COMMIT');
    const staff = await loadStaff(id);
    return jsonResponse(staff);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error updating staff member:', error);
    return errorResponse('Failed to update staff member');
  } finally {
    client.release();
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: idStr } = await params;
  const id = parseInt(idStr);
  if (isNaN(id)) return errorResponse('Invalid ID', 400);
  try {
    await ensureStaffTables();
    const result = await query('DELETE FROM crm_staff WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return errorResponse('Coach not found', 404);
    return jsonResponse({ success: true });
  } catch (error) {
    console.error('Error deleting staff member:', error);
    return errorResponse('Failed to delete staff member');
  }
}
