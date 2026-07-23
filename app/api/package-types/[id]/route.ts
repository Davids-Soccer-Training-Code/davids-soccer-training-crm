import { query } from '@/lib/db';
import { jsonResponse, errorResponse } from '@/lib/api-helpers';
import { ensurePackageTypeTables } from '../route';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensurePackageTypeTables();
    const { id } = await params;
    const body = await request.json();

    const existing = await query('SELECT id FROM crm_package_types WHERE id = $1', [id]);
    if (existing.rows.length === 0) return errorResponse('Package type not found', 404);

    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if ('label' in body) {
      const label = typeof body.label === 'string' ? body.label.trim() : '';
      if (!label) return errorResponse('Name cannot be empty', 400);
      fields.push(`label = $${paramIndex++}`);
      values.push(label);
    }
    if ('total_sessions' in body) {
      const total = Number(body.total_sessions);
      if (!Number.isInteger(total) || total < 1) {
        return errorResponse('Total sessions must be a whole number of at least 1', 400);
      }
      fields.push(`total_sessions = $${paramIndex++}`);
      values.push(total);
    }
    if ('sessions_per_week' in body) {
      const spw = Number(body.sessions_per_week);
      if (!Number.isInteger(spw) || spw < 1) {
        return errorResponse('Sessions per week must be a whole number of at least 1', 400);
      }
      fields.push(`sessions_per_week = $${paramIndex++}`);
      values.push(spw);
    }
    if ('is_active' in body) {
      fields.push(`is_active = $${paramIndex++}`);
      values.push(Boolean(body.is_active));
    }

    if (fields.length === 0) return errorResponse('No fields to update', 400);

    fields.push('updated_at = NOW()');
    values.push(id);

    const result = await query(
      `UPDATE crm_package_types SET ${fields.join(', ')} WHERE id = $${paramIndex}
       RETURNING id, key, label, total_sessions, sessions_per_week, is_builtin, is_active, created_at, updated_at`,
      values
    );
    return jsonResponse(result.rows[0]);
  } catch (error) {
    console.error('Error updating package type:', error);
    return errorResponse('Failed to update package type');
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await ensurePackageTypeTables();
    const { id } = await params;

    const existing = await query(
      'SELECT id, key, is_builtin FROM crm_package_types WHERE id = $1',
      [id]
    );
    if (existing.rows.length === 0) return errorResponse('Package type not found', 404);

    const row = existing.rows[0];
    if (row.is_builtin) {
      return errorResponse('Built-in package types cannot be deleted. Deactivate it instead.', 400);
    }

    const inUse = await query(
      'SELECT 1 FROM crm_packages WHERE package_type = $1 LIMIT 1',
      [row.key]
    );
    if (inUse.rows.length > 0) {
      return errorResponse(
        'This package type is used by existing packages. Deactivate it instead of deleting.',
        409
      );
    }

    await query('DELETE FROM crm_package_types WHERE id = $1', [id]);
    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error('Error deleting package type:', error);
    return errorResponse('Failed to delete package type');
  }
}
