import { query } from '@/lib/db';
import { jsonResponse, errorResponse } from '@/lib/api-helpers';
import { NextRequest } from 'next/server';

export const dynamic = 'force-dynamic';

// The four hard-coded package types. They stay defined here so they can always
// be re-seeded, but they live in the DB too (editable / deactivatable).
export const BUILTIN_PACKAGE_TYPES = [
  { key: '12_week_1x', label: '12 Weeks - 1x/week (12 sessions)', total_sessions: 12, sessions_per_week: 1 },
  { key: '12_week_2x', label: '12 Weeks - 2x/week (24 sessions)', total_sessions: 24, sessions_per_week: 2 },
  { key: '6_week_1x', label: '6 Weeks - 1x/week (6 sessions)', total_sessions: 6, sessions_per_week: 1 },
  { key: '6_week_2x', label: '6 Weeks - 2x/week (12 sessions)', total_sessions: 12, sessions_per_week: 2 },
] as const;

let ensurePackageTypeTablesPromise: Promise<void> | null = null;

export async function ensurePackageTypeTables(): Promise<void> {
  if (ensurePackageTypeTablesPromise) {
    await ensurePackageTypeTablesPromise;
    return;
  }
  ensurePackageTypeTablesPromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS crm_package_types (
        id SERIAL PRIMARY KEY,
        key TEXT UNIQUE NOT NULL,
        label TEXT NOT NULL,
        total_sessions INTEGER NOT NULL,
        sessions_per_week INTEGER NOT NULL DEFAULT 1,
        is_builtin BOOLEAN NOT NULL DEFAULT false,
        is_active BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(
      `ALTER TABLE crm_packages ADD COLUMN IF NOT EXISTS sessions_per_week INTEGER`
    );
    // Legacy CHECK constraint pinned package_type to the four built-in keys;
    // custom types are validated in the API instead, so drop it if present.
    await query(
      `ALTER TABLE crm_packages DROP CONSTRAINT IF EXISTS crm_packages_package_type_check`
    );

    // Seed built-ins. ON CONFLICT DO NOTHING so user edits/deactivations persist.
    for (const t of BUILTIN_PACKAGE_TYPES) {
      await query(
        `INSERT INTO crm_package_types (key, label, total_sessions, sessions_per_week, is_builtin, is_active)
         VALUES ($1, $2, $3, $4, true, true)
         ON CONFLICT (key) DO NOTHING`,
        [t.key, t.label, t.total_sessions, t.sessions_per_week]
      );
    }

    // Backfill sessions_per_week on existing packages from their type.
    await query(
      `UPDATE crm_packages pkg
       SET sessions_per_week = pt.sessions_per_week
       FROM crm_package_types pt
       WHERE pt.key = pkg.package_type AND pkg.sessions_per_week IS NULL`
    );
    await query(
      `UPDATE crm_packages SET sessions_per_week = 1 WHERE sessions_per_week IS NULL`
    );
  })().catch((error) => {
    ensurePackageTypeTablesPromise = null;
    throw error;
  });
  await ensurePackageTypeTablesPromise;
}

/**
 * Resolve a package type by key. Falls back to the hard-coded built-in
 * definition if the row is somehow missing. Returns null for unknown keys.
 */
export async function resolvePackageType(
  key: string
): Promise<{ total_sessions: number; sessions_per_week: number } | null> {
  await ensurePackageTypeTables();
  const result = await query(
    `SELECT total_sessions, sessions_per_week FROM crm_package_types WHERE key = $1 AND is_active = true`,
    [key]
  );
  if (result.rows.length > 0) {
    return {
      total_sessions: Number(result.rows[0].total_sessions),
      sessions_per_week: Number(result.rows[0].sessions_per_week),
    };
  }
  const builtin = BUILTIN_PACKAGE_TYPES.find((t) => t.key === key);
  if (builtin) {
    return { total_sessions: builtin.total_sessions, sessions_per_week: builtin.sessions_per_week };
  }
  return null;
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

async function generateUniqueKey(label: string): Promise<string> {
  const base = slugify(label) || 'custom';
  let candidate = base;
  let suffix = 2;
  // Loop until the key is unused.
  while (true) {
    const existing = await query('SELECT 1 FROM crm_package_types WHERE key = $1', [candidate]);
    if (existing.rows.length === 0) return candidate;
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
}

export async function GET(request: NextRequest) {
  try {
    await ensurePackageTypeTables();
    const includeInactive = request.nextUrl.searchParams.get('include_inactive') === '1';
    const result = await query(
      `SELECT id, key, label, total_sessions, sessions_per_week, is_builtin, is_active, created_at, updated_at
       FROM crm_package_types
       ${includeInactive ? '' : 'WHERE is_active = true'}
       ORDER BY is_builtin DESC, created_at ASC, id ASC`
    );
    return jsonResponse(result.rows);
  } catch (error) {
    console.error('Error fetching package types:', error);
    return errorResponse('Failed to fetch package types');
  }
}

export async function POST(request: NextRequest) {
  try {
    await ensurePackageTypeTables();
    const body = await request.json();
    const label = typeof body.label === 'string' ? body.label.trim() : '';
    const totalSessions = Number(body.total_sessions);
    const sessionsPerWeek = Number(body.sessions_per_week);

    if (!label) return errorResponse('Name is required', 400);
    if (!Number.isInteger(totalSessions) || totalSessions < 1) {
      return errorResponse('Total sessions must be a whole number of at least 1', 400);
    }
    if (!Number.isInteger(sessionsPerWeek) || sessionsPerWeek < 1) {
      return errorResponse('Sessions per week must be a whole number of at least 1', 400);
    }
    if (sessionsPerWeek > totalSessions) {
      return errorResponse('Sessions per week cannot exceed total sessions', 400);
    }

    const key = await generateUniqueKey(label);
    const result = await query(
      `INSERT INTO crm_package_types (key, label, total_sessions, sessions_per_week, is_builtin, is_active)
       VALUES ($1, $2, $3, $4, false, true)
       RETURNING id, key, label, total_sessions, sessions_per_week, is_builtin, is_active, created_at, updated_at`,
      [key, label, totalSessions, sessionsPerWeek]
    );
    return jsonResponse(result.rows[0], 201);
  } catch (error) {
    console.error('Error creating package type:', error);
    return errorResponse('Failed to create package type');
  }
}
