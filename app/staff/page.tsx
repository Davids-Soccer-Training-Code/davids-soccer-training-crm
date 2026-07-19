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
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
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
  is_owner: boolean;
  players: AssignedPlayer[];
}

interface PlayerOption { id: number; name: string; parent_name: string; coach_id: number | null }

type StaffForm = {
  name: string; email: string; phone: string; role: string;
  preferred_location: string; player_ages: string; player_notes: string;
  description: string; preferred_days: string; preferred_times: string;
  is_owner: boolean; player_ids: number[];
};

const EMPTY_FORM: StaffForm = {
  name: '', email: '', phone: '', role: '', preferred_location: '',
  player_ages: '', player_notes: '', description: '', preferred_days: '',
  preferred_times: '', is_owner: false, player_ids: [],
};

interface PaymentSession {
  id: number;
  kind: 'first' | 'package' | 'session';
  session_date: string;
  parent_name: string;
  player_names: string[];
  value: number;
  coach_source: 'session' | 'package' | 'player' | null;
}

interface CoachPayments {
  coach_id: number | null;
  coach_name: string | null;
  is_owner: boolean;
  sessions: PaymentSession[];
  total_value: number;
  coach_payout: number;
}

interface PaymentsResponse {
  week_start: string;
  week_end: string;
  payout_rate: number;
  grand_total_value: number;
  owed_to_coaches: number;
  owner_take: number;
  coaches: CoachPayments[];
}

const KIND_LABELS: Record<PaymentSession['kind'], string> = {
  first: 'First session',
  package: 'Package session',
  session: 'Session',
};

// Today's calendar date in Arizona, as YYYY-MM-DD.
function arizonaTodayStr(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });
}

// Monday (YYYY-MM-DD) of the week containing dateStr, shifted by weekOffset
// weeks. Uses UTC arithmetic on the plain calendar date to avoid DST/tz drift.
function mondayOf(dateStr: string, weekOffset = 0): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0 Sun .. 6 Sat
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  dt.setUTCDate(dt.getUTCDate() + diffToMonday + weekOffset * 7);
  return dt.toISOString().slice(0, 10);
}

function formatWeekRange(mondayStr: string): string {
  const [y, m, d] = mondayStr.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const fmt = (dt: Date) =>
    dt.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}, ${end.getUTCFullYear()}`;
}

function formatSessionWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/Phoenix',
    weekday: 'short',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function money(value: number): string {
  return `$${(value || 0).toFixed(2)}`;
}

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

  const [weekOffset, setWeekOffset] = useState(0);
  const [payments, setPayments] = useState<PaymentsResponse | null>(null);
  const [paymentsLoading, setPaymentsLoading] = useState(true);

  const weekStart = mondayOf(arizonaTodayStr(), weekOffset);

  useEffect(() => { loadAll(); }, []);

  useEffect(() => { loadPayments(weekStart); }, [weekStart]);

  async function loadPayments(startDate: string) {
    setPaymentsLoading(true);
    try {
      const res = await fetch(`/api/staff/payments?week_start=${startDate}`, { cache: 'no-store' });
      setPayments(res.ok ? await res.json() : null);
    } catch {
      setPayments(null);
    } finally {
      setPaymentsLoading(false);
    }
  }

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
      is_owner: s.is_owner ?? false,
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

      {/* Coach Payments */}
      <Box sx={{ mt: 5 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1, mb: 2 }}>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>Coach Payments</Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Button size="small" onClick={() => setWeekOffset((w) => w - 1)}>◀ Prev</Button>
            <Button size="small" onClick={() => setWeekOffset(0)} disabled={weekOffset === 0}>This week</Button>
            <Button size="small" onClick={() => setWeekOffset((w) => w + 1)}>Next ▶</Button>
          </Box>
        </Box>

        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Week of {formatWeekRange(weekStart)} · non-owner coaches earn 50% of each session&apos;s value; the owner keeps the rest
        </Typography>

        {paymentsLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}><CircularProgress /></Box>
        ) : !payments || payments.coaches.length === 0 ? (
          <Card variant="outlined">
            <CardContent sx={{ textAlign: 'center', py: 5 }}>
              <Typography color="text.secondary">No sessions scheduled this week.</Typography>
            </CardContent>
          </Card>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            {payments.grand_total_value > 0 && (
              <Card variant="outlined" sx={{ bgcolor: 'action.hover' }}>
                <CardContent sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', py: 1.5, gap: 2, flexWrap: 'wrap' }}>
                  <Box>
                    <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Total this week</Typography>
                    <Typography variant="body2" color="text.secondary">Session value {money(payments.grand_total_value)}</Typography>
                  </Box>
                  <Box sx={{ textAlign: 'right' }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 700, color: 'success.main' }}>
                      Owed to coaches {money(payments.owed_to_coaches)}
                    </Typography>
                    <Typography variant="body2" color="text.secondary">Owner keeps {money(payments.owner_take)}</Typography>
                  </Box>
                </CardContent>
              </Card>
            )}

            {payments.coaches.map((coach) => {
              const unassigned = coach.coach_id == null;
              return (
                <Card key={coach.coach_id ?? 'unassigned'} variant="outlined">
                  <CardContent>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                        <Typography variant="subtitle1" sx={{ fontWeight: 600, color: unassigned ? 'warning.main' : 'text.primary' }}>
                          {unassigned ? '⚠ No coach assigned' : coach.coach_name}
                          <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 1 }}>
                            · {coach.sessions.length} session{coach.sessions.length === 1 ? '' : 's'}
                          </Typography>
                        </Typography>
                        {coach.is_owner && (
                          <Chip label="Owner" size="small" color="primary" variant="outlined" sx={{ height: 20 }} />
                        )}
                      </Box>
                      {!unassigned && (
                        <Box sx={{ textAlign: 'right' }}>
                          <Typography variant="body2" color="text.secondary">Value {money(coach.total_value)}</Typography>
                          {coach.is_owner ? (
                            <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>Keeps 100%</Typography>
                          ) : (
                            <Typography variant="subtitle1" sx={{ fontWeight: 700, color: 'success.main' }}>
                              Due {money(coach.coach_payout)}
                            </Typography>
                          )}
                        </Box>
                      )}
                    </Box>
                    <Divider sx={{ my: 1 }} />
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                      {coach.sessions.map((s) => (
                        <Box key={`${s.kind}-${s.id}`} sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', minWidth: 0 }}>
                            <Typography variant="body2" component="span">
                              {formatSessionWhen(s.session_date)} — {s.player_names.length > 0 ? s.player_names.join(', ') : s.parent_name}
                            </Typography>
                            <Chip label={KIND_LABELS[s.kind]} size="small" variant="outlined" sx={{ height: 18, fontSize: '0.65rem' }} />
                            {(s.coach_source === 'package' || s.coach_source === 'player') && (
                              <Chip
                                label={s.coach_source === 'package' ? 'via package' : 'via player'}
                                size="small"
                                color="info"
                                variant="outlined"
                                sx={{ height: 18, fontSize: '0.65rem' }}
                              />
                            )}
                          </Box>
                          <Typography variant="body2" sx={{ whiteSpace: 'nowrap' }} color="text.secondary">{money(s.value)}</Typography>
                        </Box>
                      ))}
                    </Box>
                  </CardContent>
                </Card>
              );
            })}
          </Box>
        )}
      </Box>

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

            <Divider />
            <FormControlLabel
              control={<Switch checked={form.is_owner} onChange={(e) => set('is_owner', e.target.checked)} />}
              label="Owner — keeps 100% of their sessions (no 50% payout split)"
            />
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
