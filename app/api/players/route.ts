import { query } from '@/lib/db';
import { jsonResponse, errorResponse } from '@/lib/api-helpers';
import { ensureStaffTables } from '../staff/route';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await ensureStaffTables();
    const result = await query(`
      SELECT pl.id, pl.name, pl.parent_id, pl.coach_id, par.name AS parent_name
      FROM crm_players pl
      JOIN crm_parents par ON par.id = pl.parent_id
      ORDER BY par.name ASC, pl.name ASC
    `);
    return jsonResponse(result.rows);
  } catch (error) {
    console.error('Error fetching players:', error);
    return errorResponse('Failed to fetch players');
  }
}
