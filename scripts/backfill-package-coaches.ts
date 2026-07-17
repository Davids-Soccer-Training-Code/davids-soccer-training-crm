#!/usr/bin/env tsx
import { config } from 'dotenv';

config({ path: '.env.local' });
config({ path: '.env' });

import { query, getPool } from '@/lib/db';
import { ensureStaffTables } from '@/app/api/staff/route';

async function main() {
  // Make sure crm_packages.coach_id (and the rest of the coach columns) exist.
  await ensureStaffTables();

  // For every package that has no coach yet, assign the coach that the parent's
  // players are most commonly assigned to (tie-break by lowest staff id).
  const result = await query(`
    WITH parent_coach AS (
      SELECT parent_id, coach_id FROM (
        SELECT
          parent_id,
          coach_id,
          ROW_NUMBER() OVER (
            PARTITION BY parent_id
            ORDER BY COUNT(*) DESC, coach_id ASC
          ) AS rn
        FROM crm_players
        WHERE coach_id IS NOT NULL
        GROUP BY parent_id, coach_id
      ) ranked
      WHERE rn = 1
    )
    UPDATE crm_packages pkg
    SET coach_id = pc.coach_id
    FROM parent_coach pc
    WHERE pkg.parent_id = pc.parent_id
      AND pkg.coach_id IS NULL
    RETURNING pkg.id, pkg.parent_id, pkg.coach_id
  `);

  console.log(`✅ Backfilled coach on ${result.rowCount} package(s).`);

  const remaining = await query(
    `SELECT COUNT(*)::int AS n FROM crm_packages WHERE coach_id IS NULL`
  );
  console.log(
    `ℹ️  ${remaining.rows[0].n} package(s) still have no coach (parent has no players with an assigned coach).`
  );

  await getPool().end();
}

main().catch(async (error) => {
  console.error('❌ Backfill failed:', error);
  await getPool().end();
  process.exit(1);
});
