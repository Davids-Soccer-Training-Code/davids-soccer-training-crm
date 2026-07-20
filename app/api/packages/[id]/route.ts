import { getClient, query } from '@/lib/db';
import { jsonResponse, errorResponse } from '@/lib/api-helpers';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const pkgResult = await query(`
      SELECT
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
        pkg.updated_at,
        pkg.coach_id,
        st.name as coach_name,
        p.name as parent_name,
        p.email as parent_email,
        (SELECT ARRAY_AGG(name ORDER BY created_at) FROM crm_players WHERE parent_id = p.id) as player_names
      FROM crm_packages pkg
      JOIN crm_parents p ON p.id = pkg.parent_id
      LEFT JOIN crm_staff st ON st.id = pkg.coach_id
      WHERE pkg.id = $1
    `, [id]);
    if (pkgResult.rows.length === 0) return errorResponse('Package not found', 404);

    // Get sessions tied to this package
    const sessionsResult = await query(
      `SELECT
         s.*,
         ARRAY_AGG(pl.name) FILTER (WHERE pl.name IS NOT NULL) as player_names,
         ARRAY_AGG(pl.id) FILTER (WHERE pl.id IS NOT NULL) as player_ids
       FROM crm_sessions s 
       LEFT JOIN crm_session_players sp ON sp.session_id = s.id
       LEFT JOIN crm_players pl ON pl.id = sp.player_id 
       WHERE s.package_id = $1 
       GROUP BY s.id
       ORDER BY s.session_date`,
      [id]
    );

    const paymentEventsResult = await query(
      `SELECT id, package_id, amount, notes, created_at
       FROM crm_package_payment_events
       WHERE package_id = $1
       ORDER BY created_at DESC, id DESC`,
      [id]
    );

    return jsonResponse({
      ...pkgResult.rows[0],
      sessions: sessionsResult.rows,
      payment_events: paymentEventsResult.rows,
    });
  } catch (error) {
    console.error('Error fetching package:', error);
    return errorResponse('Failed to fetch package');
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let client: Awaited<ReturnType<typeof getClient>> | null = null;
  try {
    client = await getClient();
    const { id } = await params;
    const body = await request.json();

    await client.query('BEGIN');

    const currentResult = await client.query(
      `SELECT id, price, amount_received FROM crm_packages WHERE id = $1 FOR UPDATE`,
      [id]
    );
    if (currentResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return errorResponse('Package not found', 404);
    }
    const currentPackage = currentResult.rows[0];

    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    const allowedFields = ['price', 'start_date', 'is_active', 'amount_received'];
    for (const field of allowedFields) {
      if (field in body) {
        if (field === 'price') {
          const parsed = body[field] == null ? null : Number(body[field]);
          if (parsed != null && !Number.isFinite(parsed)) {
            await client.query('ROLLBACK');
            return errorResponse(`Invalid ${field}`, 400);
          }
          fields.push(`${field} = $${paramIndex}`);
          values.push(parsed);
        } else if (field === 'amount_received') {
          const parsed = body[field] == null ? 0 : Number(body[field]);
          if (!Number.isFinite(parsed)) {
            await client.query('ROLLBACK');
            return errorResponse(`Invalid ${field}`, 400);
          }
          fields.push(`${field} = $${paramIndex}`);
          values.push(parsed);
        } else {
          fields.push(`${field} = $${paramIndex}`);
          values.push(body[field]);
        }
        paramIndex++;
      }
    }

    if (fields.length === 0) {
      await client.query('ROLLBACK');
      return errorResponse('No fields to update', 400);
    }

    const nextPrice =
      body.price !== undefined
        ? (body.price == null ? null : Number(body.price))
        : (currentPackage.price == null ? null : Number(currentPackage.price));
    const nextAmountReceived =
      body.amount_received !== undefined
        ? (body.amount_received == null ? 0 : Number(body.amount_received))
        : Number(currentPackage.amount_received ?? 0);

    if (!Number.isFinite(nextAmountReceived) || nextAmountReceived < 0) {
      await client.query('ROLLBACK');
      return errorResponse('Invalid amount_received', 400);
    }
    if (nextPrice != null && nextAmountReceived > nextPrice) {
      await client.query('ROLLBACK');
      return errorResponse('Amount received cannot be greater than package price', 400);
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const result = await client.query(
      `UPDATE crm_packages SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
      values
    );

    await client.query('COMMIT');
    return jsonResponse(result.rows[0]);
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('Error updating package:', error);
    return errorResponse('Failed to update package');
  } finally {
    if (client) client.release();
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let client: Awaited<ReturnType<typeof getClient>> | null = null;
  try {
    client = await getClient();
    const { id } = await params;
    await client.query('BEGIN');

    const existingResult = await client.query('SELECT id FROM crm_packages WHERE id = $1 FOR UPDATE', [id]);
    if (existingResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return errorResponse('Package not found', 404);
    }

    await client.query(
      `UPDATE crm_sessions
       SET package_id = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE package_id = $1`,
      [id]
    );

    await client.query('DELETE FROM crm_package_payment_events WHERE package_id = $1', [id]);

    await client.query('DELETE FROM crm_packages WHERE id = $1 RETURNING id', [id]);
    await client.query('COMMIT');

    return jsonResponse({ deleted: true });
  } catch (error) {
    if (client) await client.query('ROLLBACK');
    console.error('Error deleting package:', error);
    return errorResponse('Failed to delete package');
  } finally {
    if (client) client.release();
  }
}
