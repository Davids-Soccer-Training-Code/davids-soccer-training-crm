#!/usr/bin/env tsx
import { config } from 'dotenv';

config({ path: '.env.local' });
config({ path: '.env' });

import { query, getPool } from '@/lib/db';
import { ensureStaffTables } from '@/app/api/staff/route';

async function main() {
  await ensureStaffTables();

  // For every UPCOMING, non-cancelled session with no coach yet, assign the
  // coach that the session's players are most commonly assigned to
  // (tie-break by lowest staff id).
  const result = await query(`
    WITH session_coach AS (
      SELECT session_id, coach_id FROM (
        SELECT
          sp.session_id,
          pl.coach_id,
          ROW_NUMBER() OVER (
            PARTITION BY sp.session_id
            ORDER BY COUNT(*) DESC, pl.coach_id ASC
          ) AS rn
        FROM crm_session_players sp
        JOIN crm_players pl ON pl.id = sp.player_id
        WHERE pl.coach_id IS NOT NULL
        GROUP BY sp.session_id, pl.coach_id
      ) ranked
      WHERE rn = 1
    )
    UPDATE crm_sessions s
    SET coach_id = sc.coach_id
    FROM session_coach sc
    WHERE s.id = sc.session_id
      AND s.coach_id IS NULL
      AND s.session_date >= NOW()
      AND COALESCE(s.cancelled, false) = false
      AND (s.status IS NULL OR s.status NOT IN ('cancelled', 'completed'))
    RETURNING s.id
  `);

  console.log(`✅ Assigned a coach to ${result.rowCount} upcoming session(s).`);

  const remaining = await query(`
    SELECT COUNT(*)::int AS n
    FROM crm_sessions s
    WHERE s.coach_id IS NULL
      AND s.session_date >= NOW()
      AND COALESCE(s.cancelled, false) = false
      AND (s.status IS NULL OR s.status NOT IN ('cancelled', 'completed'))
  `);
  console.log(
    `ℹ️  ${remaining.rows[0].n} upcoming session(s) still have no coach (their players have no assigned coach).`
  );

  await getPool().end();
}

main().catch(async (error) => {
  console.error('❌ Backfill failed:', error);
  await getPool().end();
  process.exit(1);
});
