# Custom Package Types — Design

**Date:** 2026-07-22

## Goal

Let the user create/manage their own package types in the CRM while keeping the
four hard-coded built-ins. Built-ins remain defined in code (seeded) but are
editable and deactivatable in the DB; they can never be permanently deleted.

## Background

Today `crm_packages.package_type` is a free string column. The four built-ins
(`12_week_1x`, `12_week_2x`, `6_week_1x`, `6_week_2x`) are hard-coded in:

- `lib/types.ts` — `PackageType` union
- `app/api/packages/route.ts` — `totalSessionsMap`
- `app/packages/page.tsx` — `packageTypeLabels` + create dropdown
- `app/packages/[id]/page.tsx` — `packageTypeLabels` + `getSessionsPerWeek()`
  (derives sessions/week by parsing the `_2x` suffix)

`total_sessions` is stored per-package at creation; `sessions_per_week` is only
derived from the suffix, which breaks for arbitrary custom keys.

Schema is applied at runtime via idempotent `ensure*Tables()` functions.

## Data model

New table **`crm_package_types`**:

| column | type | notes |
|---|---|---|
| id | SERIAL PK | |
| key | TEXT UNIQUE NOT NULL | stored in `crm_packages.package_type`; built-ins keep existing keys; custom auto-slugged from label |
| label | TEXT NOT NULL | display name |
| total_sessions | INTEGER NOT NULL | |
| sessions_per_week | INTEGER NOT NULL DEFAULT 1 | drives auto-scheduler |
| is_builtin | BOOLEAN NOT NULL DEFAULT false | |
| is_active | BOOLEAN NOT NULL DEFAULT true | soft on/off |
| created_at / updated_at | TIMESTAMPTZ DEFAULT NOW() | |

New column **`crm_packages.sessions_per_week INTEGER`** — set at package creation
from the resolved type; existing rows backfilled from their `_2x` suffix. The
detail page reads this stored value instead of parsing the suffix.

`ensurePackageTypeTables()` creates the table + column and upserts the four
built-ins with `ON CONFLICT (key) DO NOTHING`, so user edits/deactivations
persist and built-ins are never silently overwritten.

## API

- `GET /api/package-types?include_inactive=1` — list; built-ins first, then
  custom by created_at. Default excludes inactive.
- `POST /api/package-types` — `{ label, total_sessions, sessions_per_week }`,
  auto-generates a unique `key`; `is_builtin=false`.
- `PATCH /api/package-types/[id]` — edit `label`, `total_sessions`,
  `sessions_per_week`, `is_active`. Allowed for built-ins and custom.
- `DELETE /api/package-types/[id]` — custom only (400 for built-ins → deactivate
  instead); blocked with 409 if any `crm_packages` row references the key.
- `POST /api/packages` — resolves `total_sessions` + `sessions_per_week` from the
  table by key (fallback to the built-in map), stores both on the row.

Package list + detail GETs join `crm_package_types` for the label and return the
stored `sessions_per_week`.

## Frontend (Packages page)

- Package-type dropdown and label lookups come from `/api/package-types`.
- A **Manage types** button opens a dialog: add a custom type (name + sessions +
  per-week), and per-row edit / activate-toggle / delete (built-ins editable,
  not deletable; deactivate offered instead).
- Detail page uses `pkg.sessions_per_week` from the API for the scheduler.

## Migration & deploy

- SQL migration `db/migrations/0001_custom_package_types.sql` (create table, add
  column, backfill, seed built-ins) wired to existing `npm run migrate`, run
  against the shared Neon DB. Runtime `ensurePackageTypeTables()` is the
  belt-and-suspenders equivalent.
- Commit → push → `vercel --prod`.

## Out of scope (YAGNI)

- Per-type default price (price stays per-package).
- Reordering types.
