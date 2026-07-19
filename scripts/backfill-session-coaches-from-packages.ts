#!/usr/bin/env tsx
/**
 * Backfill coach_id on sessions that don't have one yet, using the same
 * fallback the payment tracker infers with: the coach on the session's
 * package first, otherwise the coach the session's players are assigned to
 * (modal, tie-break by lowest staff id).
 *
 * - Only fills NULL coach_id — never overwrites an explicitly set coach.
 * - Covers past and future sessions (the tracker looks at any week).
 * - Skips cancelled sessions.
 *
 * Pass --apply to write changes; without it the script only previews.
 */
import { config } from 'dotenv';
config({ path: '.env.local' });
config({ path: '.env' });

import { query, getPool } from '@/lib/db';
import { ensureStaffTables } from '@/app/api/staff/route';

const APPLY = process.argv.includes('--apply');

const PLAYER_COACH_CTE = `
  WITH player_coach AS (
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
`;

async function main() {
  await ensureStaffTables();

  // Preview what will be assigned, and from which source.
  const preview = await query(`
    ${PLAYER_COACH_CTE}
    SELECT
      s.id,
      s.session_date,
      p.name AS parent_name,
      COALESCE(pkg.coach_id, pc.coach_id) AS new_coach_id,
      st.name AS new_coach_name,
      CASE WHEN pkg.coach_id IS NOT NULL THEN 'package' ELSE 'player' END AS source
    FROM crm_sessions s
    JOIN crm_parents p ON p.id = s.parent_id
    LEFT JOIN crm_packages pkg ON pkg.id = s.package_id
    LEFT JOIN player_coach pc ON pc.session_id = s.id
    LEFT JOIN crm_staff st ON st.id = COALESCE(pkg.coach_id, pc.coach_id)
    WHERE s.coach_id IS NULL
      AND COALESCE(s.cancelled, false) = false
      AND COALESCE(s.status, '') <> 'cancelled'
      AND COALESCE(pkg.coach_id, pc.coach_id) IS NOT NULL
    ORDER BY st.name, s.session_date
  `);

  console.log(`\n${preview.rows.length} session(s) will be assigned a coach:\n`);
  const byCoach: Record<string, number> = {};
  for (const r of preview.rows) {
    byCoach[r.new_coach_name] = (byCoach[r.new_coach_name] || 0) + 1;
    console.log(
      `  #${r.id} ${new Date(r.session_date).toISOString().slice(0, 10)} ` +
        `${r.parent_name} -> ${r.new_coach_name} (via ${r.source})`
    );
  }
  console.log('\nSummary:');
  for (const [name, n] of Object.entries(byCoach)) console.log(`  ${name}: ${n}`);

  // How many are left with no inferable coach (for visibility).
  const stuck = await query(`
    SELECT COUNT(*)::int AS n
    FROM crm_sessions s
    LEFT JOIN crm_packages pkg ON pkg.id = s.package_id
    WHERE s.coach_id IS NULL
      AND COALESCE(s.cancelled, false) = false
      AND COALESCE(s.status, '') <> 'cancelled'
      AND pkg.coach_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM crm_session_players sp
        JOIN crm_players pl ON pl.id = sp.player_id
        WHERE sp.session_id = s.id AND pl.coach_id IS NOT NULL
      )
  `);
  console.log(
    `\n${stuck.rows[0].n} non-cancelled session(s) still have no coach and none can be inferred ` +
      `(no package coach, no player coach) — assign these manually.`
  );

  if (!APPLY) {
    console.log('\nDRY RUN — re-run with --apply to write these changes.');
    await getPool().end();
    return;
  }

  const result = await query(`
    ${PLAYER_COACH_CTE}
    UPDATE crm_sessions s
    SET coach_id = COALESCE(pkg.coach_id, pc.coach_id),
        updated_at = CURRENT_TIMESTAMP
    FROM (SELECT id, package_id FROM crm_sessions) s2
    LEFT JOIN crm_packages pkg ON pkg.id = s2.package_id
    LEFT JOIN player_coach pc ON pc.session_id = s2.id
    WHERE s.id = s2.id
      AND s.coach_id IS NULL
      AND COALESCE(s.cancelled, false) = false
      AND COALESCE(s.status, '') <> 'cancelled'
      AND COALESCE(pkg.coach_id, pc.coach_id) IS NOT NULL
    RETURNING s.id
  `);

  console.log(`\n✅ Applied: assigned a coach to ${result.rowCount} session(s).`);
  await getPool().end();
}

main().catch(async (error) => {
  console.error('❌ Backfill failed:', error);
  await getPool().end();
  process.exit(1);
});
