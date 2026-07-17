import { NextRequest } from 'next/server';
import { query, getClient } from '@/lib/db';
import { jsonResponse, errorResponse } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

let ensureStaffTablesPromise: Promise<void> | null = null;

export async function ensureStaffTables(): Promise<void> {
  if (ensureStaffTablesPromise) {
    await ensureStaffTablesPromise;
    return;
  }
  ensureStaffTablesPromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS crm_staff (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        role TEXT,
        preferred_location TEXT,
        player_ages TEXT,
        player_notes TEXT,
        description TEXT,
        preferred_days TEXT,
        preferred_times TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(
      `ALTER TABLE crm_players ADD COLUMN IF NOT EXISTS coach_id INTEGER REFERENCES crm_staff(id) ON DELETE SET NULL`
    );
    await query(
      `ALTER TABLE crm_sessions ADD COLUMN IF NOT EXISTS coach_id INTEGER REFERENCES crm_staff(id) ON DELETE SET NULL`
    );
  })().catch((error) => {
    ensureStaffTablesPromise = null;
    throw error;
  });
  await ensureStaffTablesPromise;
}

const STAFF_COLUMNS =
  'id, name, email, phone, role, preferred_location, player_ages, player_notes, description, preferred_days, preferred_times, created_at, updated_at';

export async function GET() {
  try {
    await ensureStaffTables();
    const result = await query(`
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
      GROUP BY s.id
      ORDER BY s.name ASC
    `);
    return jsonResponse(result.rows);
  } catch (error) {
    console.error('Error fetching staff:', error);
    return errorResponse('Failed to fetch staff');
  }
}

export async function POST(request: NextRequest) {
  const client = await getClient();
  try {
    await ensureStaffTables();
    const body = await request.json();
    const {
      name, email, phone, role, preferred_location, player_ages,
      player_notes, description, preferred_days, preferred_times, player_ids,
    } = body as Record<string, unknown> & { player_ids?: number[] };

    if (typeof name !== 'string' || !name.trim()) {
      return errorResponse('Coach name is required', 400);
    }

    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO crm_staff
        (name, email, phone, role, preferred_location, player_ages, player_notes, description, preferred_days, preferred_times)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING ${STAFF_COLUMNS}`,
      [
        name.trim(),
        (email as string)?.trim() || null,
        (phone as string)?.trim() || null,
        (role as string)?.trim() || null,
        (preferred_location as string)?.trim() || null,
        (player_ages as string)?.trim() || null,
        (player_notes as string)?.trim() || null,
        (description as string)?.trim() || null,
        (preferred_days as string)?.trim() || null,
        (preferred_times as string)?.trim() || null,
      ]
    );
    const staff = inserted.rows[0];

    if (Array.isArray(player_ids) && player_ids.length > 0) {
      await client.query(
        `UPDATE crm_players SET coach_id = $1 WHERE id = ANY($2::int[])`,
        [staff.id, player_ids]
      );
    }
    await client.query('COMMIT');

    return jsonResponse({ ...staff, players: [] }, 201);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error creating staff:', error);
    return errorResponse('Failed to create staff');
  } finally {
    client.release();
  }
}
