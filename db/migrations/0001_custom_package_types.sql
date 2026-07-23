-- Custom package types: a table of package "deals" so the four hard-coded
-- built-ins can live alongside user-defined custom ones.

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
);

ALTER TABLE crm_packages ADD COLUMN IF NOT EXISTS sessions_per_week INTEGER;

INSERT INTO crm_package_types (key, label, total_sessions, sessions_per_week, is_builtin, is_active)
VALUES
  ('12_week_1x', '12 Weeks - 1x/week (12 sessions)', 12, 1, true, true),
  ('12_week_2x', '12 Weeks - 2x/week (24 sessions)', 24, 2, true, true),
  ('6_week_1x', '6 Weeks - 1x/week (6 sessions)', 6, 1, true, true),
  ('6_week_2x', '6 Weeks - 2x/week (12 sessions)', 12, 2, true, true)
ON CONFLICT (key) DO NOTHING;

UPDATE crm_packages pkg
SET sessions_per_week = pt.sessions_per_week
FROM crm_package_types pt
WHERE pt.key = pkg.package_type AND pkg.sessions_per_week IS NULL;

UPDATE crm_packages SET sessions_per_week = 1 WHERE sessions_per_week IS NULL;
