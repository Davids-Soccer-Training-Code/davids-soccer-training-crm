# Staff (Coaches) Feature — Design

Date: 2026-07-17
Status: Approved

## Summary

Add a **Staff** section to the CRM for managing coaches. Each staff member is a
coach profile with contact info, role, preferred location/days/times, a bio, and
an age range they work with. Coaches can be assigned real players from the CRM
(one coach per player). When booking a session, selecting a player autofills that
player's assigned coach into a new **Coach** field on the booking form, editable
per session. Staff records support full add / edit / delete.

## Requirements

- A Staff page listing all coaches, with add / edit / delete.
- Coach fields (all free-text except name), mirroring the intake data:
  - `name` (required), `email`, `phone`, `role` (free-text, e.g. "Head Coach"),
    `preferred_location`, `player_ages` (e.g. "4-21"),
    `player_notes` (free-text for tentative names, e.g. "Could be: Gabriel"),
    `description` (bio / notes), `preferred_days`, `preferred_times`.
- Assign real player records to a coach. One coach per player.
- Session booking autofills the coach based on the selected player, overridable.
- Not hard-coded: any coach can be chosen at booking time.

## Data Model

### New table `crm_staff`
```
id                 SERIAL PRIMARY KEY
name               TEXT NOT NULL
email              TEXT
phone              TEXT
role               TEXT
preferred_location TEXT
player_ages        TEXT
player_notes       TEXT
description        TEXT
preferred_days     TEXT
preferred_times    TEXT
created_at         TIMESTAMPTZ DEFAULT NOW()
updated_at         TIMESTAMPTZ DEFAULT NOW()
```

### Player → coach link (one coach per player)
Add to `crm_players`:
```
coach_id INTEGER REFERENCES crm_staff(id) ON DELETE SET NULL
```
Storing the coach on the player makes "one coach per player" a natural
constraint and makes autofill a single lookup. Assigning players to a coach on
the Staff page sets/moves their `coach_id`.

### Session coach
Add to `crm_sessions`:
```
coach_id INTEGER REFERENCES crm_staff(id) ON DELETE SET NULL
```
Records which coach ran the session. Autofilled from the player's `coach_id` but
independently editable.

### Schema creation
Follow the existing inline `ensureTables()` pattern (no migration files). The
staff route's `ensureTables()`:
1. `CREATE TABLE IF NOT EXISTS crm_staff (...)`
2. `ALTER TABLE crm_players  ADD COLUMN IF NOT EXISTS coach_id INTEGER REFERENCES crm_staff(id) ON DELETE SET NULL`
3. `ALTER TABLE crm_sessions ADD COLUMN IF NOT EXISTS coach_id INTEGER REFERENCES crm_staff(id) ON DELETE SET NULL`

## API

### `app/api/staff/route.ts`
- `GET` — list all staff, ordered by name. Each row includes its assigned
  players (id + name, and parent name for context) via a join / aggregate on
  `crm_players.coach_id`.
- `POST` — create a staff record from the body fields. Optionally accept
  `player_ids` to assign on creation (sets those players' `coach_id`).
- `ensureTables()` runs the schema creation above.

### `app/api/staff/[id]/route.ts`
- `GET` — single staff record with assigned players.
- `PUT` — update fields; accept `player_ids` as the full desired assignment set.
  Reassign: clear `coach_id` on players no longer listed that currently point to
  this coach, set `coach_id = id` on the listed players (moving them from any
  other coach). Wrap in a transaction (`getClient`).
- `DELETE` — delete the staff row. `ON DELETE SET NULL` clears `coach_id` on any
  players and past sessions automatically. No other data is destroyed.

## UI

### `app/staff/page.tsx`
Client component following the `app/phone-lists/page.tsx` pattern (MUI, fetch
from the API). Shows a list/grid of coach cards with their key info and assigned
player names. An "Add Coach" button opens a form (dialog or inline) with all
fields plus a multi-select of players to assign (players listed with their
parent name for disambiguation). Each card has Edit and Delete actions. Delete
confirms first.

Player options for the assign multi-select come from a players list — reuse an
existing players endpoint if one returns all players with parent context;
otherwise add a lightweight fetch. (Confirm the available endpoint during
implementation.)

### `components/sessions/SessionForm.tsx`
- Fetch the staff list on mount for the Coach dropdown.
- Add `coachId` state and a **Coach** `TextField`/`Select` (optional field).
- Autofill: when `playerIds` changes, look up the assigned coach of the first
  selected player that has one and set `coachId` — but only when the user hasn't
  manually overridden it (track a "coach touched" flag so autofill doesn't stomp
  a manual choice). Selecting a player with no coach leaves the field as-is.
- Include `coach_id` in the POST payload.

### Supporting data changes
- `/api/parents/[id]/players` (the endpoint the form uses to load a parent's
  players) must include `coach_id` on each player so the form can autofill
  without an extra round-trip.
- The sessions `GET`/`POST` (and any session edit route) include/accept
  `coach_id` so it persists and displays.

### `components/layout/AppShell.tsx`
Add a "Staff" nav item (e.g. `BadgeIcon` or `SportsSoccerIcon`) pointing to
`/staff`, alongside the existing items.

## Seed data (first three coaches, added via the UI after build)

1. **MarcAnthony Simpson** — Mgsimpson119@gmail.com, 480-738-2219, Head Coach,
   Holmes Park (Basin, 1450 S Greenfield Rd, Mesa, AZ 85206), ages 4-21,
   player notes "Could be: Dakshit, Daniel", bio as provided, days
   "Monday - Saturday", times "Monday - Saturday 8am-11am Mon/Tues/Thurs/Sat 4pm-8pm".
2. **Simon Njuguna** — Simongachogo14@gmail.com, +1 (859) 202-6351, Head Coach,
   Discovery District Park (2214 E Pecos Rd, Gilbert, AZ 85297), ages 4-21,
   assigned players Kai + Dean, player notes "Could be: Gabriel", bio as
   provided, days "Tuesday-Friday", times "Tuesday/Wednesday 4-8pm Tuesday-Friday 8am-11am".

(The third intake block is a duplicate of Simon and is not entered twice.)

## Out of scope

- Coach login / auth / permissions.
- Coach-specific calendars, availability enforcement, or scheduling conflicts.
- Reporting on coach load or utilization.
- Notifications to coaches (existing reminder system is untouched here).

## Testing / verification

- Run the dev server; create, edit, and delete a coach; confirm persistence.
- Assign players to a coach and confirm reassignment moves them.
- In the booking form, select a player with an assigned coach and confirm the
  Coach field autofills, that a manual override sticks, and that the saved
  session persists `coach_id`.
