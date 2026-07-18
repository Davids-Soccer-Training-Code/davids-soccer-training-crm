import { query } from '@/lib/db';
import { jsonResponse, errorResponse } from '@/lib/api-helpers';
import { ensureStaffTables } from '@/app/api/staff/route';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    await ensureStaffTables();
    const result = await query(`
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
        (SELECT ARRAY_AGG(name ORDER BY created_at) FROM crm_players WHERE parent_id = p.id) as player_names
      FROM crm_packages pkg
      JOIN crm_parents p ON p.id = pkg.parent_id
      LEFT JOIN crm_staff st ON st.id = pkg.coach_id
      ORDER BY pkg.is_active DESC, pkg.created_at DESC
    `);
    return jsonResponse(result.rows);
  } catch (error) {
    console.error('Error fetching packages:', error);
    return errorResponse('Failed to fetch packages');
  }
}

export async function POST(request: NextRequest) {
  try {
    await ensureStaffTables();
    const body = await request.json();
    const { parent_id, package_type, price, start_date, amount_received, coach_id } = body;

    if (!parent_id || !package_type) {
      return errorResponse('Parent and package type are required', 400);
    }

    const totalSessionsMap: Record<string, number> = {
      '12_week_1x': 12,
      '12_week_2x': 24,
      '6_week_1x': 6,
      '6_week_2x': 12,
    };

    const totalSessions = totalSessionsMap[package_type];
    if (!totalSessions) return errorResponse('Invalid package type', 400);

    const parsedPrice = price == null ? null : Number(price);
    if (parsedPrice != null && !Number.isFinite(parsedPrice)) {
      return errorResponse('Invalid package price', 400);
    }

    const initialAmountReceived =
      amount_received == null
        ? 0
        : Number(amount_received);

    if (!Number.isFinite(initialAmountReceived) || initialAmountReceived < 0) {
      return errorResponse('Invalid amount received', 400);
    }

    if (parsedPrice != null && initialAmountReceived > parsedPrice) {
      return errorResponse('Amount received cannot be greater than package price', 400);
    }

    const result = await query(
      `INSERT INTO crm_packages (parent_id, package_type, total_sessions, price, start_date, amount_received, coach_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [parent_id, package_type, totalSessions, parsedPrice, start_date || null, initialAmountReceived, coach_id || null]
    );
    const createdPackage = result.rows[0];

    if (initialAmountReceived !== 0) {
      await query(
        `INSERT INTO crm_package_payment_events (package_id, amount, notes, created_at)
         VALUES ($1, $2, $3, $4)`,
        [createdPackage.id, initialAmountReceived, 'initial_package_amount', createdPackage.created_at]
      );
    }

    // Update parent interest_in_package
    await query(
      `UPDATE crm_parents SET interest_in_package = true, updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [parent_id]
    );

    return jsonResponse(createdPackage, 201);
  } catch (error) {
    console.error('Error creating package:', error);
    return errorResponse('Failed to create package');
  }
}
