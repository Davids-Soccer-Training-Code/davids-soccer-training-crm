# Staff (Coaches) Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Staff section to manage coaches, assign real players to them (one coach per player), and autofill the assigned coach into the session booking form.

**Architecture:** Follow the existing feature pattern exactly: a `crm_`-prefixed table created inline via `ensureTables()`, `force-dynamic` API routes returning JSON via `lib/api-helpers`, and a client-side MUI page mirroring `app/phone-lists/page.tsx`. The player→coach link is a `coach_id` column on `crm_players` (natural one-coach-per-player). Sessions carry their own `coach_id`, autofilled from the selected player's coach but editable.

**Tech Stack:** Next.js 16 (App Router), React 19, PostgreSQL via `pg` (`lib/db.ts` `query`/`getClient`), MUI 7.

## Global Constraints

- Database tables use the `crm_` prefix (e.g. `crm_staff`). Existing: `crm_parents`, `crm_players`, `crm_sessions`, `crm_session_players`.
- Every API route file starts with `export const dynamic = 'force-dynamic';`.
- API responses use `jsonResponse(data, status?)` / `errorResponse(message, status?)` from `@/lib/api-helpers`.
- DB access is `import { query, getClient } from '@/lib/db'`. Params are `$1, $2, …`.
- Route handler params are `{ params }: { params: Promise<{ id: string }> }` and must be `await`ed (Next 16).
- No automated test framework exists in this repo. The verification cycle for every task is: (1) `npx tsc --noEmit` passes, (2) exercise the behavior against the running dev server, (3) commit. Do NOT add a test framework.
- Dev server: start via the browser preview tool with the `.claude/launch.json` config named `dev` (create it if missing: `npm run dev`, port 3000). Never run the dev server with plain Bash.
- Commit after each task with a `feat:`/`chore:` message. Work stays on branch `feature/staff-coaches`.

---

### Task 1: Staff list + create API and schema

**Files:**
- Create: `app/api/staff/route.ts`

**Interfaces:**
- Produces: `GET /api/staff` → `StaffWithPlayers[]` where each row is
  `{ id, name, email, phone, role, preferred_location, player_ages, player_notes, description, preferred_days, preferred_times, created_at, updated_at, players: { id: number, name: string, parent_name: string }[] }`.
- Produces: `POST /api/staff` body `{ name, email?, phone?, role?, preferred_location?, player_ages?, player_notes?, description?, preferred_days?, preferred_times?, player_ids?: number[] }` → created staff row (201).
- Produces: exported async `ensureStaffTables()` that creates `crm_staff` and adds `coach_id` to `crm_players` and `crm_sessions`. Later tasks call it.

- [ ] **Step 1: Create the route file with schema + GET + POST**

Create `app/api/staff/route.ts`:

```typescript
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
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Start the dev server and exercise the API**

Start the dev server (browser preview tool, config `dev`). Then verify create + list:

```bash
curl -s -X POST http://localhost:3000/api/staff \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test Coach","email":"t@e.com","role":"Head Coach"}'
curl -s http://localhost:3000/api/staff
```
Expected: POST returns a JSON object with `id` and `"players":[]`; GET returns an array containing "Test Coach". (Leave this record — it is deleted in Task 2's verification.)

- [ ] **Step 4: Commit**

```bash
git add app/api/staff/route.ts
git commit -m "feat: add staff list/create API and crm_staff schema"
```

---

### Task 2: Staff detail API (get/update/delete)

**Files:**
- Create: `app/api/staff/[id]/route.ts`

**Interfaces:**
- Consumes: `ensureStaffTables` from `@/app/api/staff/route`.
- Produces: `GET /api/staff/:id` → staff row + `players` array (same shape as Task 1 GET rows).
- Produces: `PUT /api/staff/:id` body = any subset of staff fields plus optional `player_ids: number[]` (full desired assignment set) → updated staff row.
- Produces: `DELETE /api/staff/:id` → `{ success: true }`.

- [ ] **Step 1: Create the detail route file**

Create `app/api/staff/[id]/route.ts`:

```typescript
import { NextRequest } from 'next/server';
import { query, getClient } from '@/lib/db';
import { jsonResponse, errorResponse } from '@/lib/api-helpers';
import { ensureStaffTables } from '../route';

export const dynamic = 'force-dynamic';

const STAFF_COLUMNS =
  'id, name, email, phone, role, preferred_location, player_ages, player_notes, description, preferred_days, preferred_times, created_at, updated_at';

const EDITABLE_FIELDS = [
  'name', 'email', 'phone', 'role', 'preferred_location',
  'player_ages', 'player_notes', 'description', 'preferred_days', 'preferred_times',
] as const;

async function loadStaff(id: number) {
  const result = await query(
    `
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
    WHERE s.id = $1
    GROUP BY s.id
  `,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: idStr } = await params;
  const id = parseInt(idStr);
  if (isNaN(id)) return errorResponse('Invalid ID', 400);
  try {
    await ensureStaffTables();
    const staff = await loadStaff(id);
    if (!staff) return errorResponse('Coach not found', 404);
    return jsonResponse(staff);
  } catch (error) {
    console.error('Error fetching staff member:', error);
    return errorResponse('Failed to fetch staff member');
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: idStr } = await params;
  const id = parseInt(idStr);
  if (isNaN(id)) return errorResponse('Invalid ID', 400);

  const client = await getClient();
  try {
    await ensureStaffTables();
    const body = (await request.json()) as Record<string, unknown> & { player_ids?: number[] };

    if ('name' in body && (typeof body.name !== 'string' || !body.name.trim())) {
      return errorResponse('Coach name cannot be empty', 400);
    }

    await client.query('BEGIN');

    const exists = await client.query('SELECT id FROM crm_staff WHERE id = $1', [id]);
    if (exists.rows.length === 0) {
      await client.query('ROLLBACK');
      return errorResponse('Coach not found', 404);
    }

    const setClauses: string[] = [];
    const values: unknown[] = [];
    for (const field of EDITABLE_FIELDS) {
      if (field in body) {
        values.push(typeof body[field] === 'string' ? (body[field] as string).trim() || null : null);
        setClauses.push(`${field} = $${values.length}`);
      }
    }
    if (setClauses.length > 0) {
      values.push(id);
      await client.query(
        `UPDATE crm_staff SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $${values.length}`,
        values
      );
    }

    if (Array.isArray(body.player_ids)) {
      // Clear players that were assigned to this coach but are no longer listed.
      await client.query(
        `UPDATE crm_players SET coach_id = NULL WHERE coach_id = $1 AND NOT (id = ANY($2::int[]))`,
        [id, body.player_ids]
      );
      // Assign (moving from any other coach) the listed players.
      if (body.player_ids.length > 0) {
        await client.query(
          `UPDATE crm_players SET coach_id = $1 WHERE id = ANY($2::int[])`,
          [id, body.player_ids]
        );
      }
    }

    await client.query('COMMIT');
    const staff = await loadStaff(id);
    return jsonResponse(staff);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Error updating staff member:', error);
    return errorResponse('Failed to update staff member');
  } finally {
    client.release();
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: idStr } = await params;
  const id = parseInt(idStr);
  if (isNaN(id)) return errorResponse('Invalid ID', 400);
  try {
    await ensureStaffTables();
    const result = await query('DELETE FROM crm_staff WHERE id = $1 RETURNING id', [id]);
    if (result.rows.length === 0) return errorResponse('Coach not found', 404);
    return jsonResponse({ success: true });
  } catch (error) {
    console.error('Error deleting staff member:', error);
    return errorResponse('Failed to delete staff member');
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Exercise get/update/delete against the dev server**

Using the "Test Coach" id from Task 1 (call it `<ID>`):

```bash
curl -s http://localhost:3000/api/staff/<ID>
curl -s -X PUT http://localhost:3000/api/staff/<ID> \
  -H 'Content-Type: application/json' -d '{"role":"Assistant Coach"}'
curl -s -X DELETE http://localhost:3000/api/staff/<ID>
curl -s http://localhost:3000/api/staff
```
Expected: GET returns the coach with `"players":[]`; PUT returns the row with `role:"Assistant Coach"`; DELETE returns `{"success":true}`; final GET no longer lists "Test Coach".

- [ ] **Step 4: Commit**

```bash
git add app/api/staff/[id]/route.ts
git commit -m "feat: add staff detail API (get/update/delete + player reassignment)"
```

---

### Task 3: All-players endpoint for the assign picker

**Files:**
- Create: `app/api/players/route.ts`

**Interfaces:**
- Produces: `GET /api/players` → `{ id: number, name: string, parent_id: number, parent_name: string, coach_id: number | null }[]`, ordered by parent name then player name.

- [ ] **Step 1: Create the collection route**

Create `app/api/players/route.ts`:

```typescript
import { query } from '@/lib/db';
import { jsonResponse, errorResponse } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
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
```

Note: `coach_id` exists on `crm_players` because Task 1's `ensureStaffTables()` runs whenever `/api/staff` is hit (the Staff page and booking form both call it on load). If you run this endpoint before ever hitting `/api/staff`, the column is still created because the Staff page (Task 4) loads staff first.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Exercise against the dev server**

```bash
curl -s http://localhost:3000/api/staff > /dev/null   # ensures coach_id column exists
curl -s http://localhost:3000/api/players
```
Expected: a JSON array of players, each with `parent_name` and a `coach_id` field (null when unassigned).

- [ ] **Step 4: Commit**

```bash
git add app/api/players/route.ts
git commit -m "feat: add all-players endpoint for coach assignment picker"
```

---

### Task 4: Staff page UI + navigation

**Files:**
- Create: `app/staff/page.tsx`
- Modify: `components/layout/AppShell.tsx` (imports near line 30; `navItems` array lines 36-50)

**Interfaces:**
- Consumes: `GET/POST /api/staff`, `GET/PUT/DELETE /api/staff/:id`, `GET /api/players`.

- [ ] **Step 1: Add the nav item in AppShell**

In `components/layout/AppShell.tsx`, add an icon import alongside the others (after line 30, `import PhoneAndroidIcon ...`):

```typescript
import BadgeIcon from '@mui/icons-material/Badge';
```

Add to the `navItems` array (place after the `Customers` entry, line 39):

```typescript
  { label: 'Staff', href: '/staff', icon: <BadgeIcon /> },
```

- [ ] **Step 2: Create the Staff page**

Create `app/staff/page.tsx`:

```typescript
'use client';

import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import CircularProgress from '@mui/material/CircularProgress';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import SaveIcon from '@mui/icons-material/Save';
import BadgeIcon from '@mui/icons-material/Badge';

interface AssignedPlayer { id: number; name: string; parent_name: string }

interface Staff {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  preferred_location: string | null;
  player_ages: string | null;
  player_notes: string | null;
  description: string | null;
  preferred_days: string | null;
  preferred_times: string | null;
  players: AssignedPlayer[];
}

interface PlayerOption { id: number; name: string; parent_name: string; coach_id: number | null }

type StaffForm = {
  name: string; email: string; phone: string; role: string;
  preferred_location: string; player_ages: string; player_notes: string;
  description: string; preferred_days: string; preferred_times: string;
  player_ids: number[];
};

const EMPTY_FORM: StaffForm = {
  name: '', email: '', phone: '', role: '', preferred_location: '',
  player_ages: '', player_notes: '', description: '', preferred_days: '',
  preferred_times: '', player_ids: [],
};

export default function StaffPage() {
  const [staff, setStaff] = useState<Staff[]>([]);
  const [players, setPlayers] = useState<PlayerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState<StaffForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<Staff | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  useEffect(() => { loadAll(); }, []);

  async function loadAll() {
    setLoading(true);
    try {
      const [staffRes, playersRes] = await Promise.all([
        fetch('/api/staff', { cache: 'no-store' }),
        fetch('/api/players', { cache: 'no-store' }),
      ]);
      setStaff(await staffRes.json());
      setPlayers(await playersRes.json());
    } catch {
      setError('Failed to load staff');
    } finally {
      setLoading(false);
    }
  }

  function set<K extends keyof StaffForm>(key: K, value: StaffForm[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function openCreate() {
    setEditId(null);
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  }

  function openEdit(s: Staff) {
    setEditId(s.id);
    setForm({
      name: s.name ?? '', email: s.email ?? '', phone: s.phone ?? '', role: s.role ?? '',
      preferred_location: s.preferred_location ?? '', player_ages: s.player_ages ?? '',
      player_notes: s.player_notes ?? '', description: s.description ?? '',
      preferred_days: s.preferred_days ?? '', preferred_times: s.preferred_times ?? '',
      player_ids: s.players.map((p) => p.id),
    });
    setDialogOpen(true);
  }

  async function handleSave() {
    if (!form.name.trim()) { setError('Coach name is required'); return; }
    setSaving(true);
    try {
      const res = await fetch(editId ? `/api/staff/${editId}` : '/api/staff', {
        method: editId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Failed to save coach'); }
      else {
        setSuccess(`Coach "${data.name}" ${editId ? 'saved' : 'added'}`);
        setDialogOpen(false);
        await loadAll();
      }
    } catch { setError('Failed to save coach'); }
    finally { setSaving(false); }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      const res = await fetch(`/api/staff/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) { const d = await res.json(); setError(d.error || 'Failed to delete coach'); }
      else {
        setSuccess(`Coach "${deleteTarget.name}" deleted`);
        setDeleteTarget(null);
        await loadAll();
      }
    } catch { setError('Failed to delete coach'); }
    finally { setDeleteLoading(false); }
  }

  if (loading) return <Typography>Loading...</Typography>;

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 700 }}>Staff</Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>Add Coach</Button>
      </Box>

      {error && <Alert severity="error" onClose={() => setError(null)} sx={{ mb: 2 }}>{error}</Alert>}
      {success && <Alert severity="success" onClose={() => setSuccess(null)} sx={{ mb: 2 }}>{success}</Alert>}

      {staff.length === 0 ? (
        <Card variant="outlined">
          <CardContent sx={{ textAlign: 'center', py: 6 }}>
            <BadgeIcon sx={{ fontSize: 48, color: 'text.disabled', mb: 1 }} />
            <Typography color="text.secondary">No staff yet. Add a coach to get started.</Typography>
          </CardContent>
        </Card>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {staff.map((s) => (
            <Card key={s.id} variant="outlined">
              <CardContent>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>{s.name}</Typography>
                      {s.role && <Chip label={s.role} size="small" color="primary" variant="outlined" />}
                    </Box>
                    {(s.email || s.phone) && (
                      <Typography variant="body2" color="text.secondary">
                        {[s.email, s.phone].filter(Boolean).join('  ·  ')}
                      </Typography>
                    )}
                    {s.preferred_location && (
                      <Typography variant="body2" color="text.secondary">📍 {s.preferred_location}</Typography>
                    )}
                    {(s.preferred_days || s.preferred_times) && (
                      <Typography variant="body2" color="text.secondary">
                        🕒 {[s.preferred_days, s.preferred_times].filter(Boolean).join(' · ')}
                      </Typography>
                    )}
                    {s.player_ages && (
                      <Typography variant="body2" color="text.secondary">Ages: {s.player_ages}</Typography>
                    )}
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 1 }}>
                      {s.players.map((p) => (
                        <Chip key={p.id} label={`${p.name} (${p.parent_name})`} size="small" />
                      ))}
                      {s.player_notes && (
                        <Chip label={s.player_notes} size="small" variant="outlined" color="warning" />
                      )}
                    </Box>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 0.5 }}>
                    <IconButton size="small" onClick={() => openEdit(s)} title="Edit coach"><EditIcon fontSize="small" /></IconButton>
                    <IconButton size="small" color="error" onClick={() => setDeleteTarget(s)} title="Delete coach"><DeleteIcon fontSize="small" /></IconButton>
                  </Box>
                </Box>
                {s.description && (
                  <Typography variant="body2" sx={{ mt: 1, whiteSpace: 'pre-wrap' }} color="text.secondary">{s.description}</Typography>
                )}
              </CardContent>
            </Card>
          ))}
        </Box>
      )}

      {/* Create/Edit dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>{editId ? 'Edit Coach' : 'Add Coach'}</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
            <TextField label="Name *" fullWidth value={form.name} onChange={(e) => set('name', e.target.value)} />
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
              <TextField label="Email" fullWidth value={form.email} onChange={(e) => set('email', e.target.value)} />
              <TextField label="Phone" fullWidth value={form.phone} onChange={(e) => set('phone', e.target.value)} />
              <TextField label="Role" fullWidth value={form.role} onChange={(e) => set('role', e.target.value)} placeholder="Head Coach" />
              <TextField label="Player Ages" fullWidth value={form.player_ages} onChange={(e) => set('player_ages', e.target.value)} placeholder="4-21" />
            </Box>
            <TextField label="Preferred Location" fullWidth value={form.preferred_location} onChange={(e) => set('preferred_location', e.target.value)} />
            <TextField label="Preferred Days" fullWidth value={form.preferred_days} onChange={(e) => set('preferred_days', e.target.value)} placeholder="Monday - Saturday" />
            <TextField label="Preferred Times" fullWidth value={form.preferred_times} onChange={(e) => set('preferred_times', e.target.value)} />

            <Divider />

            <TextField
              label="Assigned Players"
              value={form.player_ids}
              onChange={(e) => set('player_ids', (typeof e.target.value === 'string' ? [] : e.target.value as unknown as number[]))}
              select
              fullWidth
              SelectProps={{
                multiple: true,
                renderValue: (selected) =>
                  players
                    .filter((p) => (selected as number[]).includes(p.id))
                    .map((p) => `${p.name} (${p.parent_name})`)
                    .join(', '),
              }}
              helperText="Players assigned here autofill this coach when you book their sessions."
            >
              {players.map((p) => (
                <MenuItem key={p.id} value={p.id}>
                  {p.name} ({p.parent_name})
                  {p.coach_id != null && !form.player_ids.includes(p.id) ? '  — assigned elsewhere' : ''}
                </MenuItem>
              ))}
            </TextField>

            <TextField label="Player Notes" fullWidth value={form.player_notes} onChange={(e) => set('player_notes', e.target.value)} placeholder="Could be: Gabriel" />
            <TextField label="Description / Bio" fullWidth multiline rows={4} value={form.description} onChange={(e) => set('description', e.target.value)} />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleSave} disabled={!form.name.trim() || saving}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}>
            {editId ? 'Save' : 'Add'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} maxWidth="xs">
        <DialogTitle>Delete Coach</DialogTitle>
        <DialogContent>
          <Typography>
            Delete <strong>{deleteTarget?.name}</strong>? Their players will be unassigned and the coach cleared from past sessions. This cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={handleDelete} disabled={deleteLoading}
            startIcon={deleteLoading ? <CircularProgress size={16} color="inherit" /> : undefined}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Verify in the browser**

With the dev server running, navigate to `http://localhost:3000/staff`. Confirm:
- "Staff" appears in the left nav with a badge icon.
- "Add Coach" opens the dialog; create a coach with all fields and assign a player. It appears as a card with role chip, contact line, and player chip.
- Edit the coach, change a field and the assigned players; save; the card reflects changes.
- Delete the coach via the confirmation dialog; it disappears.
Use the browser tools to screenshot the populated Staff page as proof.

- [ ] **Step 5: Commit**

```bash
git add app/staff/page.tsx components/layout/AppShell.tsx
git commit -m "feat: add Staff page UI and navigation"
```

---

### Task 5: Coach autofill in session booking

**Files:**
- Modify: `app/api/sessions/route.ts` (POST: destructure + INSERT, lines ~63-118)
- Modify: `components/sessions/SessionForm.tsx`

**Interfaces:**
- Consumes: `GET /api/staff` (coach list), `coach_id` on players from `/api/parents/:id/players` (already `SELECT *`, so the column is included once it exists).
- Produces: `POST /api/sessions` accepts optional `coach_id: number | null` and persists it on `crm_sessions`.

- [ ] **Step 1: Persist coach_id in the sessions POST**

In `app/api/sessions/route.ts`, add `coach_id` to the destructure (the block starting `const { parent_id, player_ids, ...`):

```typescript
    const {
      parent_id,
      player_ids,
      session_date,
      session_end_date,
      location,
      price,
      package_id,
      notes,
      coach_id,
    } = body;
```

Update the INSERT to include the column and value. Replace the existing `crm_sessions` INSERT call with:

```typescript
    const result = await query(
      `INSERT INTO crm_sessions (parent_id, title, session_date, session_end_date, location, price, package_id, notes, guest_emails, send_email_updates, coach_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        parent_id,
        normalizedTitle,
        sessionDateUTC,
        sessionEndDateUTC,
        location || null,
        price || null,
        package_id || null,
        notes || null,
        guestEmails,
        sendEmailUpdates,
        coach_id || null,
      ]
    );
```

Note: the `coach_id` column is created by `ensureStaffTables()`. The booking form (Step 2) fetches `/api/staff` on mount, which runs `ensureStaffTables()` before any session is submitted, so the column exists. No change to the GET is needed — it already uses `s.*`.

- [ ] **Step 2: Add coach state, fetch, autofill, and payload in SessionForm**

In `components/sessions/SessionForm.tsx`:

(a) After the existing state declarations (after line 49, `const [depositAmount, setDepositAmount] = useState('');`), add:

```typescript
  const [staff, setStaff] = useState<{ id: number; name: string }[]>([]);
  const [coachId, setCoachId] = useState('');
  const coachTouchedRef = useRef(false);
```

(b) After the `fetch('/api/parents')` effect (after line 53), add an effect to load staff:

```typescript
  useEffect(() => {
    fetch('/api/staff').then((r) => r.json()).then((rows) =>
      setStaff(rows.map((s: { id: number; name: string }) => ({ id: s.id, name: s.name })))
    );
  }, []);
```

(c) Replace the players-fetch effect (lines 56-64) so it also autofills the coach from the selected players. Change the `.then(setPlayers)` to capture players and reset the touched flag when the parent changes:

```typescript
  // Fetch players when parent is selected
  useEffect(() => {
    coachTouchedRef.current = false;
    if (parentId) {
      fetch(`/api/parents/${parentId}/players`)
        .then((r) => r.json())
        .then(setPlayers);
    } else {
      setPlayers([]);
    }
  }, [parentId]);
```

(d) Add a new effect after it that autofills the coach whenever the selected players (or the loaded player list) change, unless the user has manually chosen a coach:

```typescript
  // Autofill coach from the first selected player that has one (unless user overrode it)
  useEffect(() => {
    if (coachTouchedRef.current) return;
    const selected = players.filter((pl) => playerIds.includes(String(pl.id)));
    const withCoach = selected.find(
      (pl) => (pl as Player & { coach_id?: number | null }).coach_id != null
    ) as (Player & { coach_id?: number | null }) | undefined;
    setCoachId(withCoach?.coach_id != null ? String(withCoach.coach_id) : '');
  }, [players, playerIds]);
```

(e) In the payload (inside `handleSubmit`, in the `payload` object around line 101), add `coach_id`:

```typescript
        coach_id: coachId ? parseInt(coachId) : null,
```

(f) Add the Coach dropdown in the form. After the Players `TextField` (closing `</TextField>` at line 190), insert:

```tsx
            <TextField
              label="Coach"
              value={coachId}
              onChange={(e) => { coachTouchedRef.current = true; setCoachId(e.target.value); }}
              select
              fullWidth
              helperText="Autofills from the selected player; change if needed."
            >
              <MenuItem value="">— None —</MenuItem>
              {staff.map((s) => (
                <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>
              ))}
            </TextField>
```

Note: `coach_id` is only sent to `/api/sessions` (regular sessions). First sessions (`/api/first-sessions`) do not persist a coach — that is intentionally out of scope. The Coach dropdown still displays for first sessions but its value is ignored on submit.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Verify autofill end-to-end in the browser**

Preconditions: at least one coach exists (Task 4) with a player assigned. With the dev server running:
- Go to `http://localhost:3000/sessions/new`.
- Select the parent of the assigned player, then select that player. Confirm the **Coach** field autofills to the assigned coach.
- Manually change the Coach to a different value; confirm changing the player selection no longer overrides your manual choice.
- Fill required fields and book the session. Then verify persistence:

```bash
curl -s "http://localhost:3000/api/sessions?upcoming=true" | grep -o '"coach_id":[0-9]*' | head
```
Expected: at least one session row with a non-null `coach_id`.
Screenshot the booking form showing the autofilled Coach field as proof.

- [ ] **Step 5: Commit**

```bash
git add app/api/sessions/route.ts components/sessions/SessionForm.tsx
git commit -m "feat: autofill assigned coach into session booking"
```

---

## Self-Review

**Spec coverage:**
- Staff table with all intake fields → Task 1 (`crm_staff`). ✓
- Add/edit/delete coaches → Tasks 1, 2, 4. ✓
- Assign real players (one coach per player) → `coach_id` on `crm_players`, set in Tasks 1/2, picker in Task 4. ✓
- Free-text player notes for "Could be" names → `player_notes` field, Tasks 1/4. ✓
- Autofill coach on booking, editable, not hard-coded → Task 5. ✓
- Delete unassigns players + clears past-session coach → `ON DELETE SET NULL` (Task 1) + confirmation copy (Task 4). ✓
- Nav entry → Task 4. ✓

**Placeholder scan:** No TBD/TODO; all steps contain complete code. ✓

**Type consistency:** `ensureStaffTables` exported in Task 1, imported in Tasks 2. `STAFF_COLUMNS` defined in both route files (duplication is acceptable — small constant, avoids a shared import for one string). `players` array shape `{id,name,parent_name}` consistent across Tasks 1, 2, 4. `coach_id` naming consistent across players endpoint, sessions route, and form. Booking form uses `coach_id` on the `Player` type via an inline cast since `lib/types.ts` `Player` does not yet declare it — the cast avoids editing the shared type; optionally add `coach_id?: number | null` to `Player` in `lib/types.ts` if preferred. ✓

## Manual seed after implementation

Once merged, add the two real coaches through the Staff UI (MarcAnthony Simpson and Simon Njuguna) with the values from the spec, assigning their confirmed players and putting tentative names in Player Notes. The duplicate Simon intake block is entered only once.
