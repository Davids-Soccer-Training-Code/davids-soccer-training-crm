'use client';

import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Paper from '@mui/material/Paper';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Alert from '@mui/material/Alert';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import GroupIcon from '@mui/icons-material/Group';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import FlashOnIcon from '@mui/icons-material/FlashOn';
import { formatArizonaDateTime, toDatetimeLocal } from '@/lib/timezone';

export const dynamic = 'force-dynamic';

interface GroupSession {
  id: number;
  title: string;
  description: string | null;
  image_url: string | null;
  session_date: string;
  session_date_end: string | null;
  location: string | null;
  price: number | null;
  curriculum: string | null;
  max_players: number;
  player_count: number;
  prospect_count: number;
  total_paid_amount: number;
  created_at: string;
  updated_at: string;
}

interface PlayerSignup {
  id: number;
  group_session_id: number;
  first_name: string;
  last_name: string;
  age: number | null;
  birthday: string | null;
  emergency_contact: string;
  contact_phone: string | null;
  contact_email: string;
  foot: string | null;
  team: string | null;
  notes: string | null;
  signup_price: number | null;
  amount_paid: number | null;
  has_paid: boolean;
  stripe_payment_intent_id: string | null;
  stripe_checkout_session_id: string | null;
  stripe_charge_id: string | null;
  stripe_receipt_url: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionFormState {
  title: string;
  description: string;
  image_url: string;
  session_date: string;
  session_date_end: string;
  location: string;
  price: string;
  curriculum: string;
  max_players: string;
}

interface PlayerFormState {
  first_name: string;
  last_name: string;
  age: string;
  birthday: string;
  emergency_contact: string;
  contact_phone: string;
  contact_email: string;
  foot: string;
  team: string;
  notes: string;
  signup_price: string;
  amount_paid: string;
  has_paid: boolean;
  stripe_payment_intent_id: string;
  stripe_checkout_session_id: string;
  stripe_charge_id: string;
  stripe_receipt_url: string;
}

interface QuickAddFormState {
  friday_date: string;
  sunday_date: string;
  curriculum: string;
  location: string;
  image_url: string;
}

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const emptySessionForm: SessionFormState = {
  title: '',
  description: '',
  image_url: '',
  session_date: '',
  session_date_end: '',
  location: '',
  price: '',
  curriculum: '',
  max_players: '8',
};

const emptyPlayerForm: PlayerFormState = {
  first_name: '',
  last_name: '',
  age: '',
  birthday: '',
  emergency_contact: '',
  contact_phone: '',
  contact_email: '',
  foot: '',
  team: '',
  notes: '',
  signup_price: '',
  amount_paid: '',
  has_paid: false,
  stripe_payment_intent_id: '',
  stripe_checkout_session_id: '',
  stripe_charge_id: '',
  stripe_receipt_url: '',
};

const emptyQuickAddForm: QuickAddFormState = {
  friday_date: '',
  sunday_date: '',
  curriculum: '',
  location: '',
  image_url: '',
};

function normalizeBirthdayInput(value: string | null | undefined): string {
  return value ? String(value).slice(0, 10) : '';
}

function formatBirthdayDisplay(value: string | null | undefined): string | null {
  if (!value) return null;
  const [year, month, day] = String(value).slice(0, 10).split('-');
  if (!year || !month || !day) return String(value).slice(0, 10);
  return `${month}/${day}/${year}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function getPlayerCollectedAmount(player: PlayerSignup): number | null {
  if (!player.has_paid) return null;
  const amount = player.amount_paid ?? player.signup_price;
  if (amount == null) return null;
  const parsed = Number(amount);
  return Number.isFinite(parsed) ? parsed : null;
}

export default function GroupSessionsPage() {
  const [sessions, setSessions] = useState<GroupSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const [editingSession, setEditingSession] = useState<GroupSession | null>(null);
  const [sessionForm, setSessionForm] = useState<SessionFormState>(emptySessionForm);
  const [savingSession, setSavingSession] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uploadingQuickAddImage, setUploadingQuickAddImage] = useState(false);
  const [quickAddDialogOpen, setQuickAddDialogOpen] = useState(false);
  const [quickAddForm, setQuickAddForm] = useState<QuickAddFormState>(emptyQuickAddForm);
  const [quickAdding, setQuickAdding] = useState(false);

  const [playersDialogSession, setPlayersDialogSession] = useState<GroupSession | null>(null);
  const [players, setPlayers] = useState<PlayerSignup[]>([]);
  const [loadingPlayers, setLoadingPlayers] = useState(false);
  const [playerDialogOpen, setPlayerDialogOpen] = useState(false);
  const [editingPlayer, setEditingPlayer] = useState<PlayerSignup | null>(null);
  const [playerForm, setPlayerForm] = useState<PlayerFormState>(emptyPlayerForm);
  const [savingPlayer, setSavingPlayer] = useState(false);

  const openSpotsBySession = useMemo(() => {
    const map: Record<number, number> = {};
    sessions.forEach((session) => {
      map[session.id] = Math.max(session.max_players - session.player_count, 0);
    });
    return map;
  }, [sessions]);

  const fetchSessions = async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/group-sessions', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load group sessions');

      const data = (await res.json()) as GroupSession[];
      setSessions(data);
    } catch (err) {
      console.error(err);
      setError('Failed to load group sessions.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  const fetchPlayers = async (groupSessionId: number) => {
    setLoadingPlayers(true);

    try {
      const res = await fetch(`/api/group-sessions/${groupSessionId}/players`, {
        cache: 'no-store',
      });

      if (!res.ok) throw new Error('Failed to load player signups');
      const data = (await res.json()) as PlayerSignup[];
      setPlayers(data);
    } catch (err) {
      console.error(err);
      setError('Failed to load players for this group session.');
    } finally {
      setLoadingPlayers(false);
    }
  };

  const openCreateSessionDialog = () => {
    setEditingSession(null);
    setSessionForm(emptySessionForm);
    setSessionDialogOpen(true);
  };

  const openQuickAddDialog = () => {
    setQuickAddForm(emptyQuickAddForm);
    setQuickAddDialogOpen(true);
  };

  const openEditSessionDialog = (session: GroupSession) => {
    setEditingSession(session);
    setSessionForm({
      title: session.title,
      description: session.description || '',
      image_url: session.image_url || '',
      session_date: toDatetimeLocal(session.session_date),
      session_date_end: session.session_date_end ? toDatetimeLocal(session.session_date_end) : '',
      location: session.location || '',
      price: session.price != null ? String(session.price) : '',
      curriculum: session.curriculum || '',
      max_players: String(session.max_players),
    });
    setSessionDialogOpen(true);
  };

  const handleSessionImageUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploadingImage(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.set('file', file);

      const res = await fetch('/api/group-sessions/upload-image', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || 'Failed to upload image');
      }

      const payload = (await res.json()) as { url: string };
      setSessionForm((prev) => ({ ...prev, image_url: payload.url }));
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to upload image');
    } finally {
      setUploadingImage(false);
      event.target.value = '';
    }
  };

  const handleQuickAddImageUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploadingQuickAddImage(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.set('file', file);

      const res = await fetch('/api/group-sessions/upload-image', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || 'Failed to upload image');
      }

      const payload = (await res.json()) as { url: string };
      setQuickAddForm((prev) => ({ ...prev, image_url: payload.url }));
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to upload image');
    } finally {
      setUploadingQuickAddImage(false);
      event.target.value = '';
    }
  };

  const saveSession = async () => {
    if (
      !sessionForm.title.trim() ||
      !sessionForm.session_date ||
      !sessionForm.location.trim() ||
      !sessionForm.image_url.trim() ||
      !sessionForm.max_players.trim()
    ) {
      setError('Title, image URL, location, date, and max players are required.');
      return;
    }

    if (
      sessionForm.session_date_end &&
      new Date(sessionForm.session_date_end).getTime() < new Date(sessionForm.session_date).getTime()
    ) {
      setError('End date must be after start date.');
      return;
    }

    setSavingSession(true);
    setError(null);

    try {
      const payload = {
        title: sessionForm.title.trim(),
        description: sessionForm.description.trim() || null,
        image_url: sessionForm.image_url.trim() || null,
        session_date: sessionForm.session_date,
        session_date_end: sessionForm.session_date_end.trim() || null,
        location: sessionForm.location.trim() || null,
        price: sessionForm.price.trim() ? Number(sessionForm.price) : null,
        curriculum: sessionForm.curriculum.trim() || null,
        max_players: Number(sessionForm.max_players),
      };

      const endpoint = editingSession
        ? `/api/group-sessions/${editingSession.id}`
        : '/api/group-sessions';

      const method = editingSession ? 'PATCH' : 'POST';

      const res = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorPayload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(errorPayload?.error || 'Failed to save group session');
      }

      setSessionDialogOpen(false);
      setEditingSession(null);
      setSessionForm(emptySessionForm);
      await fetchSessions();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to save group session');
    } finally {
      setSavingSession(false);
    }
  };

  const deleteSession = async (session: GroupSession) => {
    const confirmed = window.confirm(
      `Delete group session "${session.title}" and all player signups in it?`
    );

    if (!confirmed) return;

    setError(null);
    try {
      const res = await fetch(`/api/group-sessions/${session.id}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const errorPayload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(errorPayload?.error || 'Failed to delete group session');
      }

      await fetchSessions();
      if (playersDialogSession?.id === session.id) {
        setPlayersDialogSession(null);
        setPlayers([]);
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to delete group session');
    }
  };

  const handleQuickAdd = async () => {
    if (
      !quickAddForm.friday_date.trim() ||
      !quickAddForm.sunday_date.trim() ||
      !quickAddForm.curriculum.trim() ||
      !quickAddForm.location.trim() ||
      !quickAddForm.image_url.trim()
    ) {
      return;
    }

    setQuickAdding(true);
    setError(null);

    try {
      const res = await fetch('/api/group-sessions/quick-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          friday_date: quickAddForm.friday_date.trim(),
          sunday_date: quickAddForm.sunday_date.trim(),
          curriculum: quickAddForm.curriculum.trim(),
          location: quickAddForm.location.trim(),
          image_url: quickAddForm.image_url.trim(),
        }),
      });

      if (!res.ok) {
        const errorPayload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(errorPayload?.error || 'Failed to quick-add group sessions');
      }

      setQuickAddDialogOpen(false);
      setQuickAddForm(emptyQuickAddForm);
      await fetchSessions();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to quick-add group sessions');
    } finally {
      setQuickAdding(false);
    }
  };

  const openPlayersDialog = async (session: GroupSession) => {
    setPlayersDialogSession(session);
    setEditingPlayer(null);
    setPlayerDialogOpen(false);
    setPlayerForm(emptyPlayerForm);
    await fetchPlayers(session.id);
  };

  const openCreatePlayerDialog = () => {
    setEditingPlayer(null);
    setPlayerForm(emptyPlayerForm);
    setPlayerDialogOpen(true);
  };

  const openEditPlayerDialog = (player: PlayerSignup) => {
    setEditingPlayer(player);
    setPlayerForm({
      first_name: player.first_name,
      last_name: player.last_name,
      age: player.age != null ? String(player.age) : '',
      birthday: normalizeBirthdayInput(player.birthday),
      emergency_contact: player.emergency_contact,
      contact_phone: player.contact_phone || '',
      contact_email: player.contact_email || '',
      foot: player.foot || '',
      team: player.team || '',
      notes: player.notes || '',
      signup_price: player.signup_price != null ? String(player.signup_price) : '',
      amount_paid: player.amount_paid != null ? String(player.amount_paid) : '',
      has_paid: player.has_paid,
      stripe_payment_intent_id: player.stripe_payment_intent_id || '',
      stripe_checkout_session_id: player.stripe_checkout_session_id || '',
      stripe_charge_id: player.stripe_charge_id || '',
      stripe_receipt_url: player.stripe_receipt_url || '',
    });
    setPlayerDialogOpen(true);
  };

  const savePlayer = async () => {
    if (!playersDialogSession) return;

    if (
      !playerForm.first_name.trim() ||
      !playerForm.last_name.trim() ||
      !playerForm.emergency_contact.trim() ||
      !playerForm.contact_email.trim()
    ) {
      return;
    }

    const signupPrice =
      playerForm.signup_price.trim() === '' ? null : Number(playerForm.signup_price.trim());
    if (signupPrice != null && (!Number.isFinite(signupPrice) || signupPrice < 0)) {
      setError('Signup price must be a valid non-negative number.');
      return;
    }

    const amountPaid =
      playerForm.amount_paid.trim() === '' ? null : Number(playerForm.amount_paid.trim());
    if (amountPaid != null && (!Number.isFinite(amountPaid) || amountPaid < 0)) {
      setError('Amount paid must be a valid non-negative number.');
      return;
    }
    if (playerForm.has_paid && amountPaid == null) {
      setError('Amount paid is required when the player is marked as paid.');
      return;
    }

    setSavingPlayer(true);
    setError(null);

    try {
      const payload = {
        first_name: playerForm.first_name.trim(),
        last_name: playerForm.last_name.trim(),
        age: playerForm.age.trim() === '' ? null : Number(playerForm.age),
        birthday: playerForm.birthday || null,
        emergency_contact: playerForm.emergency_contact.trim(),
        contact_phone: playerForm.contact_phone.trim() || null,
        contact_email: playerForm.contact_email.trim(),
        foot: playerForm.foot.trim() || null,
        team: playerForm.team.trim() || null,
        notes: playerForm.notes.trim() || null,
        signup_price: signupPrice,
        amount_paid: playerForm.has_paid ? amountPaid : null,
        has_paid: playerForm.has_paid,
        stripe_payment_intent_id: playerForm.stripe_payment_intent_id.trim() || null,
        stripe_checkout_session_id: playerForm.stripe_checkout_session_id.trim() || null,
        stripe_charge_id: playerForm.stripe_charge_id.trim() || null,
        stripe_receipt_url: playerForm.stripe_receipt_url.trim() || null,
      };

      const endpoint = editingPlayer
        ? `/api/player-signups/${editingPlayer.id}`
        : `/api/group-sessions/${playersDialogSession.id}/players`;
      const method = editingPlayer ? 'PATCH' : 'POST';

      const res = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorPayload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(errorPayload?.error || 'Failed to save player');
      }

      setPlayerDialogOpen(false);
      setEditingPlayer(null);
      setPlayerForm(emptyPlayerForm);
      await Promise.all([fetchPlayers(playersDialogSession.id), fetchSessions()]);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to save player');
    } finally {
      setSavingPlayer(false);
    }
  };

  const deletePlayer = async (player: PlayerSignup) => {
    if (!playersDialogSession) return;

    const confirmed = window.confirm(
      `Delete player signup for ${player.first_name} ${player.last_name}?`
    );

    if (!confirmed) return;

    setError(null);

    try {
      const res = await fetch(`/api/player-signups/${player.id}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const errorPayload = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(errorPayload?.error || 'Failed to delete player');
      }

      await Promise.all([fetchPlayers(playersDialogSession.id), fetchSessions()]);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to delete player');
    }
  };

  const activePlayersDialogSession = playersDialogSession
    ? sessions.find((session) => session.id === playersDialogSession.id) || playersDialogSession
    : null;
  const paidPlayers = players.filter((player) => player.has_paid);
  const prospectPlayers = players.filter((player) => !player.has_paid);
  const sessionCollectedTotal = round2(
    paidPlayers.reduce((sum, player) => sum + (getPlayerCollectedAmount(player) ?? 0), 0)
  );

  const renderPlayerTable = (rows: PlayerSignup[]) => (
    <TableContainer component={Paper} variant="outlined">
      <Table size="small" sx={{ tableLayout: 'fixed' }}>
        <TableHead>
          <TableRow>
            <TableCell sx={{ width: '26%' }}>Player</TableCell>
            <TableCell sx={{ width: '20%' }}>Contact</TableCell>
            <TableCell sx={{ width: '28%' }}>Details</TableCell>
            <TableCell sx={{ width: '10%' }}>Spent</TableCell>
            <TableCell sx={{ width: '8%' }}>Paid</TableCell>
            <TableCell align="right" sx={{ width: '8%' }}>Actions</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((player) => {
            const collected = getPlayerCollectedAmount(player);
            return (
            <TableRow key={player.id} hover>
              <TableCell>
                <Typography sx={{ fontWeight: 600 }}>
                  {player.first_name} {player.last_name}
                </Typography>
                {player.notes && (
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}
                  >
                    {player.notes}
                  </Typography>
                )}
              </TableCell>
              <TableCell>
                <Typography>{player.emergency_contact}</Typography>
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}
                >
                  {player.contact_email}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {player.contact_phone || 'No phone'}
                </Typography>
              </TableCell>
              <TableCell>
                {[
                  formatBirthdayDisplay(player.birthday) &&
                    `Birthday: ${formatBirthdayDisplay(player.birthday)}`,
                  player.team && `Team: ${player.team}`,
                  player.foot && `Foot: ${player.foot}`,
                  player.signup_price != null && `Signup: ${money.format(player.signup_price)}`,
                  player.amount_paid != null && `Paid: ${money.format(player.amount_paid)}`,
                ]
                  .filter(Boolean)
                  .join(' · ') || '—'}
              </TableCell>
              <TableCell>{collected != null ? money.format(collected) : '—'}</TableCell>
              <TableCell>
                <Chip
                  size="small"
                  color={player.has_paid ? 'success' : 'default'}
                  label={player.has_paid ? 'Paid' : 'Unpaid'}
                />
              </TableCell>
              <TableCell align="right">
                <IconButton
                  size="small"
                  title="Edit player"
                  onClick={() => openEditPlayerDialog(player)}
                >
                  <EditIcon fontSize="small" />
                </IconButton>
                <IconButton
                  size="small"
                  color="error"
                  title="Delete player"
                  onClick={() => deletePlayer(player)}
                >
                  <DeleteIcon fontSize="small" />
                </IconButton>
              </TableCell>
            </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );

  if (loading) return <Typography>Loading group sessions...</Typography>;

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h4" sx={{ fontWeight: 700 }}>
          Group Sessions
        </Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button variant="outlined" startIcon={<FlashOnIcon />} onClick={openQuickAddDialog}>
            Quick Add
          </Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={openCreateSessionDialog}>
            New Group Session
          </Button>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {sessions.length === 0 ? (
        <Card>
          <CardContent sx={{ textAlign: 'center', py: 6 }}>
            <Typography color="text.secondary">
              No group sessions yet. Create your first group session.
            </Typography>
          </CardContent>
        </Card>
      ) : (
        <TableContainer component={Paper}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Session</TableCell>
                <TableCell>Date</TableCell>
                <TableCell>Location</TableCell>
                <TableCell>Price</TableCell>
                <TableCell>Collected</TableCell>
                <TableCell>Players</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sessions.map((session) => {
                const spotsLeft = openSpotsBySession[session.id] ?? 0;
                return (
                  <TableRow key={session.id} hover>
                    <TableCell sx={{ minWidth: 260 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                        {session.image_url ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={session.image_url}
                            alt={session.title}
                            style={{
                              width: 52,
                              height: 52,
                              objectFit: 'cover',
                              borderRadius: 8,
                              border: '1px solid #e5e7eb',
                            }}
                          />
                        ) : (
                          <Box
                            sx={{
                              width: 52,
                              height: 52,
                              borderRadius: 2,
                              bgcolor: 'grey.100',
                              border: '1px solid',
                              borderColor: 'grey.300',
                            }}
                          />
                        )}
                        <Box>
                          <Typography sx={{ fontWeight: 600 }}>{session.title}</Typography>
                          {session.description && (
                            <Typography
                              variant="body2"
                              color="text.secondary"
                              sx={{ whiteSpace: 'normal', overflowWrap: 'anywhere' }}
                            >
                              {session.description}
                            </Typography>
                          )}
                        </Box>
                      </Box>
                    </TableCell>
                    <TableCell>
                      <Typography sx={{ fontWeight: 600 }}>
                        {formatArizonaDateTime(session.session_date)}
                      </Typography>
                      {session.session_date_end && (
                        <Typography variant="body2" color="text.secondary">
                          to {formatArizonaDateTime(session.session_date_end)}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>{session.location || '—'}</TableCell>
                    <TableCell>{session.price != null ? money.format(session.price) : '—'}</TableCell>
                    <TableCell>{money.format(session.total_paid_amount || 0)}</TableCell>
                    <TableCell>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                        <Chip
                          size="small"
                          color={spotsLeft === 0 ? 'error' : 'primary'}
                          label={`${session.player_count}/${session.max_players}`}
                        />
                        <Typography variant="body2" color="text.secondary">
                          {spotsLeft} spot{spotsLeft === 1 ? '' : 's'} left
                        </Typography>
                        {session.prospect_count > 0 && (
                          <Typography variant="body2" color="text.secondary">
                            {session.prospect_count} prospect{session.prospect_count === 1 ? '' : 's'}
                          </Typography>
                        )}
                      </Box>
                    </TableCell>
                    <TableCell align="right">
                      <IconButton
                        size="small"
                        title="Manage players"
                        onClick={() => openPlayersDialog(session)}
                      >
                        <GroupIcon fontSize="small" />
                      </IconButton>
                      <IconButton
                        size="small"
                        title="Edit group session"
                        onClick={() => openEditSessionDialog(session)}
                      >
                        <EditIcon fontSize="small" />
                      </IconButton>
                      <IconButton
                        size="small"
                        color="error"
                        title="Delete group session"
                        onClick={() => deleteSession(session)}
                      >
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Dialog
        open={quickAddDialogOpen}
        onClose={() => setQuickAddDialogOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Quick Add Weekend Sessions</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1, mb: 2 }}>
            Creates 4 sessions: Friday (8-10, 11-13) and Sunday (8-10, 11-13), each at
            $50 with 12 max players.
          </Typography>
          <Box sx={{ display: 'grid', gap: 2 }}>
            <TextField
              label="Friday Date *"
              type="date"
              value={quickAddForm.friday_date}
              onChange={(e) =>
                setQuickAddForm((prev) => ({ ...prev, friday_date: e.target.value }))
              }
              fullWidth
              required
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              label="Sunday Date *"
              type="date"
              value={quickAddForm.sunday_date}
              onChange={(e) =>
                setQuickAddForm((prev) => ({ ...prev, sunday_date: e.target.value }))
              }
              fullWidth
              required
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              label="Curriculum *"
              value={quickAddForm.curriculum}
              onChange={(e) =>
                setQuickAddForm((prev) => ({ ...prev, curriculum: e.target.value }))
              }
              multiline
              rows={3}
              fullWidth
              required
            />
            <TextField
              label="Location *"
              value={quickAddForm.location}
              onChange={(e) =>
                setQuickAddForm((prev) => ({ ...prev, location: e.target.value }))
              }
              fullWidth
              required
            />
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <Button
                component="label"
                variant="outlined"
                startIcon={<UploadFileIcon />}
                disabled={uploadingQuickAddImage}
              >
                {uploadingQuickAddImage ? 'Uploading...' : 'Upload Image'}
                <input hidden type="file" accept="image/*" onChange={handleQuickAddImageUpload} />
              </Button>
              <Typography variant="body2" color="text.secondary">
                Vercel Blob upload
              </Typography>
            </Box>
            <TextField
              label="Image URL *"
              value={quickAddForm.image_url}
              onChange={(e) =>
                setQuickAddForm((prev) => ({ ...prev, image_url: e.target.value }))
              }
              fullWidth
              required
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setQuickAddDialogOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={handleQuickAdd}
            disabled={
              quickAdding ||
              !quickAddForm.friday_date.trim() ||
              !quickAddForm.sunday_date.trim() ||
              !quickAddForm.curriculum.trim() ||
              !quickAddForm.location.trim() ||
              !quickAddForm.image_url.trim()
            }
          >
            {quickAdding ? 'Adding...' : 'Create 4 Sessions'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={sessionDialogOpen}
        onClose={() => setSessionDialogOpen(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>{editingSession ? 'Edit Group Session' : 'Create Group Session'}</DialogTitle>
        <DialogContent>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
              gap: 2,
              mt: 1,
            }}
          >
            <TextField
              label="Title *"
              value={sessionForm.title}
              onChange={(e) => setSessionForm((prev) => ({ ...prev, title: e.target.value }))}
              fullWidth
              required
            />
            <TextField
              label="Date & Time *"
              type="datetime-local"
              value={sessionForm.session_date}
              onChange={(e) =>
                setSessionForm((prev) => ({ ...prev, session_date: e.target.value }))
              }
              fullWidth
              required
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              label="End Date & Time"
              type="datetime-local"
              value={sessionForm.session_date_end}
              onChange={(e) =>
                setSessionForm((prev) => ({ ...prev, session_date_end: e.target.value }))
              }
              fullWidth
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              label="Location *"
              value={sessionForm.location}
              onChange={(e) => setSessionForm((prev) => ({ ...prev, location: e.target.value }))}
              fullWidth
              required
            />
            <TextField
              label="Price ($)"
              type="number"
              value={sessionForm.price}
              onChange={(e) => setSessionForm((prev) => ({ ...prev, price: e.target.value }))}
              fullWidth
            />
            <TextField
              label="Max Players *"
              type="number"
              value={sessionForm.max_players}
              onChange={(e) =>
                setSessionForm((prev) => ({ ...prev, max_players: e.target.value }))
              }
              fullWidth
              required
            />
            <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
              <Button
                component="label"
                variant="outlined"
                startIcon={<UploadFileIcon />}
                disabled={uploadingImage}
              >
                {uploadingImage ? 'Uploading...' : 'Upload Image'}
                <input
                  hidden
                  type="file"
                  accept="image/*"
                  onChange={handleSessionImageUpload}
                />
              </Button>
              <Typography variant="body2" color="text.secondary">
                Vercel Blob upload
              </Typography>
            </Box>
            <TextField
              label="Image URL *"
              value={sessionForm.image_url}
              onChange={(e) => setSessionForm((prev) => ({ ...prev, image_url: e.target.value }))}
              fullWidth
              required
              sx={{ gridColumn: { xs: 'span 1', md: 'span 2' } }}
            />
            <TextField
              label="Description"
              value={sessionForm.description}
              onChange={(e) =>
                setSessionForm((prev) => ({ ...prev, description: e.target.value }))
              }
              multiline
              rows={3}
              fullWidth
              sx={{ gridColumn: { xs: 'span 1', md: 'span 2' } }}
            />
            <TextField
              label="Curriculum"
              value={sessionForm.curriculum}
              onChange={(e) =>
                setSessionForm((prev) => ({ ...prev, curriculum: e.target.value }))
              }
              multiline
              rows={3}
              fullWidth
              sx={{ gridColumn: { xs: 'span 1', md: 'span 2' } }}
            />
          </Box>

          {sessionForm.image_url && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                Image preview
              </Typography>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={sessionForm.image_url}
                alt="Group session preview"
                style={{
                  maxWidth: '100%',
                  maxHeight: 220,
                  objectFit: 'cover',
                  borderRadius: 8,
                  border: '1px solid #e5e7eb',
                }}
              />
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSessionDialogOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={saveSession}
            disabled={
              savingSession ||
              !sessionForm.title.trim() ||
              !sessionForm.session_date ||
              !sessionForm.location.trim() ||
              !sessionForm.image_url.trim() ||
              !sessionForm.max_players.trim()
            }
          >
            {savingSession ? 'Saving...' : editingSession ? 'Save Changes' : 'Create Session'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={Boolean(activePlayersDialogSession)}
        onClose={() => setPlayersDialogSession(null)}
        maxWidth="lg"
        fullWidth
      >
        <DialogTitle>
          {activePlayersDialogSession
            ? `Players in ${activePlayersDialogSession.title}`
            : 'Group Players'}
        </DialogTitle>
        <DialogContent>
          {activePlayersDialogSession && (
            <Box
              sx={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                mb: 2,
                mt: 1,
                gap: 2,
                flexWrap: 'wrap',
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Chip
                  size="small"
                  color={paidPlayers.length >= activePlayersDialogSession.max_players ? 'error' : 'primary'}
                  label={`${paidPlayers.length}/${activePlayersDialogSession.max_players} paid`}
                />
                <Chip
                  size="small"
                  color="success"
                  variant="outlined"
                  label={`made ${money.format(sessionCollectedTotal)}`}
                />
                <Typography variant="body2" color="text.secondary">
                  {Math.max(activePlayersDialogSession.max_players - paidPlayers.length, 0)} spot
                  {Math.max(activePlayersDialogSession.max_players - paidPlayers.length, 0) === 1
                    ? ''
                    : 's'}
                  {' '}left
                </Typography>
                <Chip
                  size="small"
                  variant="outlined"
                  label={`${prospectPlayers.length} prospect${prospectPlayers.length === 1 ? '' : 's'}`}
                />
              </Box>
              <Button
                variant="contained"
                startIcon={<AddIcon />}
                onClick={openCreatePlayerDialog}
              >
                Add Player
              </Button>
            </Box>
          )}

          {loadingPlayers ? (
            <Typography>Loading players...</Typography>
          ) : players.length === 0 ? (
            <Typography color="text.secondary">No players in this group session yet.</Typography>
          ) : (
            <Box sx={{ display: 'grid', gap: 2 }}>
              <Box>
                <Typography sx={{ fontWeight: 700, mb: 1 }}>Players (Paid)</Typography>
                {paidPlayers.length === 0 ? (
                  <Typography color="text.secondary">No paid players yet.</Typography>
                ) : (
                  renderPlayerTable(paidPlayers)
                )}
              </Box>

              <Box>
                <Typography sx={{ fontWeight: 700, mb: 1 }}>Prospects (Unpaid)</Typography>
                {prospectPlayers.length === 0 ? (
                  <Typography color="text.secondary">No unpaid prospects.</Typography>
                ) : (
                  renderPlayerTable(prospectPlayers)
                )}
              </Box>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPlayersDialogSession(null)}>Close</Button>
        </DialogActions>
      </Dialog>

      <Dialog
        open={playerDialogOpen}
        onClose={() => setPlayerDialogOpen(false)}
        maxWidth="md"
        fullWidth
      >
        <DialogTitle>{editingPlayer ? 'Edit Player' : 'Add Player'}</DialogTitle>
        <DialogContent>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
              gap: 2,
              mt: 1,
            }}
          >
            <TextField
              label="First Name *"
              value={playerForm.first_name}
              onChange={(e) => setPlayerForm((prev) => ({ ...prev, first_name: e.target.value }))}
              fullWidth
              required
            />
            <TextField
              label="Last Name *"
              value={playerForm.last_name}
              onChange={(e) => setPlayerForm((prev) => ({ ...prev, last_name: e.target.value }))}
              fullWidth
              required
            />
            <TextField
              label="Age"
              type="number"
              value={playerForm.age}
              onChange={(e) => setPlayerForm((prev) => ({ ...prev, age: e.target.value }))}
              fullWidth
            />
            <TextField
              label="Birthday"
              type="date"
              value={playerForm.birthday}
              onChange={(e) =>
                setPlayerForm((prev) => ({ ...prev, birthday: e.target.value }))
              }
              fullWidth
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              label="Emergency Contact *"
              value={playerForm.emergency_contact}
              onChange={(e) =>
                setPlayerForm((prev) => ({ ...prev, emergency_contact: e.target.value }))
              }
              fullWidth
              required
            />
            <TextField
              label="Contact Email *"
              type="email"
              value={playerForm.contact_email}
              onChange={(e) =>
                setPlayerForm((prev) => ({ ...prev, contact_email: e.target.value }))
              }
              fullWidth
              required
            />
            <TextField
              label="Contact Phone"
              value={playerForm.contact_phone}
              onChange={(e) =>
                setPlayerForm((prev) => ({ ...prev, contact_phone: e.target.value }))
              }
              fullWidth
            />
            <TextField
              label="Foot"
              value={playerForm.foot}
              onChange={(e) => setPlayerForm((prev) => ({ ...prev, foot: e.target.value }))}
              fullWidth
            />
            <TextField
              label="Team"
              value={playerForm.team}
              onChange={(e) => setPlayerForm((prev) => ({ ...prev, team: e.target.value }))}
              fullWidth
            />
            <TextField
              label="Signup Price"
              type="number"
              value={playerForm.signup_price}
              onChange={(e) =>
                setPlayerForm((prev) => ({ ...prev, signup_price: e.target.value }))
              }
              fullWidth
              inputProps={{ min: 0, step: '0.01' }}
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={playerForm.has_paid}
                  onChange={(e) =>
                    setPlayerForm((prev) => ({ ...prev, has_paid: e.target.checked }))
                  }
                />
              }
              label="Has Paid"
            />
            <TextField
              label="Amount Paid"
              type="number"
              value={playerForm.amount_paid}
              onChange={(e) =>
                setPlayerForm((prev) => ({ ...prev, amount_paid: e.target.value }))
              }
              fullWidth
              required={playerForm.has_paid}
              disabled={!playerForm.has_paid}
              inputProps={{ min: 0, step: '0.01' }}
              helperText={playerForm.has_paid ? 'Required when marked paid' : 'Set Has Paid to enter amount'}
            />
            <TextField
              label="Notes"
              value={playerForm.notes}
              onChange={(e) => setPlayerForm((prev) => ({ ...prev, notes: e.target.value }))}
              multiline
              rows={2}
              fullWidth
              sx={{ gridColumn: { xs: 'span 1', md: 'span 2' } }}
            />
            <TextField
              label="Stripe Payment Intent ID"
              value={playerForm.stripe_payment_intent_id}
              onChange={(e) =>
                setPlayerForm((prev) => ({ ...prev, stripe_payment_intent_id: e.target.value }))
              }
              fullWidth
              sx={{ gridColumn: { xs: 'span 1', md: 'span 2' } }}
            />
            <TextField
              label="Stripe Checkout Session ID"
              value={playerForm.stripe_checkout_session_id}
              onChange={(e) =>
                setPlayerForm((prev) => ({
                  ...prev,
                  stripe_checkout_session_id: e.target.value,
                }))
              }
              fullWidth
              sx={{ gridColumn: { xs: 'span 1', md: 'span 2' } }}
            />
            <TextField
              label="Stripe Charge ID"
              value={playerForm.stripe_charge_id}
              onChange={(e) =>
                setPlayerForm((prev) => ({ ...prev, stripe_charge_id: e.target.value }))
              }
              fullWidth
              sx={{ gridColumn: { xs: 'span 1', md: 'span 2' } }}
            />
            <TextField
              label="Stripe Receipt URL"
              value={playerForm.stripe_receipt_url}
              onChange={(e) =>
                setPlayerForm((prev) => ({ ...prev, stripe_receipt_url: e.target.value }))
              }
              fullWidth
              sx={{ gridColumn: { xs: 'span 1', md: 'span 2' } }}
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPlayerDialogOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            onClick={savePlayer}
            disabled={
              savingPlayer ||
              !playerForm.first_name.trim() ||
              !playerForm.last_name.trim() ||
              !playerForm.emergency_contact.trim() ||
              !playerForm.contact_email.trim() ||
              (playerForm.has_paid && !playerForm.amount_paid.trim())
            }
          >
            {savingPlayer ? 'Saving...' : editingPlayer ? 'Save Changes' : 'Add Player'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
