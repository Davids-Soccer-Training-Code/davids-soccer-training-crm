'use client';

import { useState, useEffect } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import CancelIcon from '@mui/icons-material/Cancel';
import EventRepeatIcon from '@mui/icons-material/EventRepeat';
import EventBusyIcon from '@mui/icons-material/EventBusy';
import EventAvailableIcon from '@mui/icons-material/EventAvailable';
import EditIcon from '@mui/icons-material/Edit';
import CheckIcon from '@mui/icons-material/Check';
import UndoIcon from '@mui/icons-material/Undo';
import { formatArizonaDateTime, toDatetimeLocal } from '@/lib/timezone';
import GooglePlacesTextField from '@/components/common/GooglePlacesTextField';

interface SessionRow {
  id: number;
  parent_id: number;
  parent_name: string;
  parent_email?: string | null;
  title?: string | null;
  player_names: string[] | null;
  player_ids: number[] | null;
  session_date: string;
  session_end_date?: string | null;
  guest_emails?: string[] | null;
  send_email_updates?: boolean | null;
  location: string | null;
  price: number | null;
  status?: string;
  showed_up: boolean | null;
  cancelled: boolean;
  was_paid: boolean;
  payment_method: string | null;
  deposit_paid?: boolean;
  deposit_amount?: number | null;
  coach_id?: number | null;
  coach_name?: string | null;
}

interface Player {
  id: number;
  name: string;
}

type SessionType = 'first' | 'regular';
type StatusAction = 'accept' | 'cancel' | 'reschedule' | 'no-show';

interface UndoState {
  previous: {
    status: string;
    cancelled: boolean;
    showed_up: boolean | null;
    was_paid: boolean;
    payment_method: string | null;
  };
}

export default function SessionList() {
  const UNDO_STORAGE_KEY = 'sessions-undo-state-v1';
  const [firstSessions, setFirstSessions] = useState<SessionRow[]>([]);
  const [regularSessions, setRegularSessions] = useState<SessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [completeDialog, setCompleteDialog] = useState<{ session: SessionRow; type: 'first' | 'regular' } | null>(null);
  const [showedUp, setShowedUp] = useState(true);
  const [cancelled, setCancelled] = useState(false);
  const [wasPaid, setWasPaid] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('');
  const [editDialog, setEditDialog] = useState<{ session: SessionRow; type: 'first' | 'regular' } | null>(null);
  const [editForm, setEditForm] = useState({
    title: '',
    session_date: '',
    session_end_date: '',
    location: '',
    price: '',
    notes: '',
    guest_emails: '',
    send_email_updates: false,
    player_ids: [] as number[],
    coach_id: '' as string,
  });
  const [availablePlayers, setAvailablePlayers] = useState<Player[]>([]);
  const [staff, setStaff] = useState<{ id: number; name: string }[]>([]);

  useEffect(() => {
    fetch('/api/staff').then((r) => r.json()).then((rows) =>
      setStaff(rows.map((s: { id: number; name: string }) => ({ id: s.id, name: s.name })))
    ).catch(() => {});
  }, []);
  const [undoStateBySession, setUndoStateBySession] = useState<Record<string, UndoState>>({});
  const [undoInProgressKey, setUndoInProgressKey] = useState<string | null>(null);

  const fetchSessions = async () => {
    setLoading(true);
    const [fsRes, sRes] = await Promise.all([
      fetch('/api/first-sessions'),
      fetch('/api/sessions'),
    ]);
    if (fsRes.ok) setFirstSessions(await fsRes.json());
    if (sRes.ok) setRegularSessions(await sRes.json());
    setLoading(false);
  };

  useEffect(() => { fetchSessions(); }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const savedUndoState = localStorage.getItem(UNDO_STORAGE_KEY);
      if (!savedUndoState) return;

      const parsedUndoState = JSON.parse(savedUndoState) as Record<string, UndoState>;
      if (parsedUndoState && typeof parsedUndoState === 'object') {
        setUndoStateBySession(parsedUndoState);
      }
    } catch (error) {
      console.error('Failed to load undo state:', error);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem(UNDO_STORAGE_KEY, JSON.stringify(undoStateBySession));
  }, [undoStateBySession]);

  const handleComplete = async () => {
    if (!completeDialog) return;
    const { session, type } = completeDialog;
    const endpoint = type === 'first'
      ? `/api/first-sessions/${session.id}/complete`
      : `/api/sessions/${session.id}/complete`;

    await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        showed_up: showedUp,
        cancelled,
        was_paid: wasPaid,
        payment_method: wasPaid ? paymentMethod : null,
      }),
    });

    setCompleteDialog(null);
    fetchSessions();
  };

  const openComplete = (session: SessionRow, type: 'first' | 'regular') => {
    setShowedUp(true);
    setCancelled(false);
    setWasPaid(false);
    setPaymentMethod('');
    setCompleteDialog({ session, type });
  };

  const updateSessionInState = (sessionId: number, type: SessionType, updates: Partial<SessionRow>) => {
    if (type === 'first') {
      setFirstSessions((prev) =>
        prev.map((session) => (session.id === sessionId ? { ...session, ...updates } : session))
      );
      return;
    }

    setRegularSessions((prev) =>
      prev.map((session) => (session.id === sessionId ? { ...session, ...updates } : session))
    );
  };

  const getUndoKey = (sessionId: number, type: SessionType) => `${type}-${sessionId}`;

  const updateSessionStatus = async (sessionId: number, type: SessionType, action: StatusAction) => {
    const sessions = type === 'first' ? firstSessions : regularSessions;
    const currentSession = sessions.find((session) => session.id === sessionId);
    if (!currentSession) return;

    const endpoint = type === 'first'
      ? `/api/first-sessions/${sessionId}/${action}`
      : `/api/sessions/${sessionId}/${action}`;

    const response = await fetch(endpoint, { method: 'POST' });
    if (!response.ok) {
      console.error('Failed to update session status');
      return;
    }

    const updatedSession = await response.json();
    updateSessionInState(sessionId, type, {
      status: updatedSession.status,
      cancelled: updatedSession.cancelled,
      showed_up: updatedSession.showed_up,
      was_paid: updatedSession.was_paid,
      payment_method: updatedSession.payment_method,
    });

    const undoKey = getUndoKey(sessionId, type);
    setUndoStateBySession((prev) => ({
      ...prev,
      [undoKey]: {
        previous: {
          status: currentSession.status || 'scheduled',
          cancelled: currentSession.cancelled,
          showed_up: currentSession.showed_up,
          was_paid: currentSession.was_paid,
          payment_method: currentSession.payment_method,
        },
      },
    }));
  };

  const handleUndoStatus = async (session: SessionRow & { sessionType: SessionType }) => {
    const { id: sessionId, sessionType: type } = session;
    const undoKey = getUndoKey(sessionId, type);
    const undoState = undoStateBySession[undoKey];
    if (undoInProgressKey === undoKey) return;

    const endpoint = type === 'first'
      ? `/api/first-sessions/${sessionId}`
      : `/api/sessions/${sessionId}`;

    const fallbackUndoPayload = {
      status: 'scheduled',
      cancelled: false,
      showed_up: null as boolean | null,
      was_paid: session.was_paid,
      payment_method: session.payment_method,
    };
    const undoPayload = undoState?.previous || fallbackUndoPayload;

    setUndoInProgressKey(undoKey);
    try {
      const response = await fetch(endpoint, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(undoPayload),
      });

      if (!response.ok) {
        console.error('Failed to undo session status change');
        return;
      }

      const restoredSession = await response.json();
      updateSessionInState(sessionId, type, {
        status: restoredSession.status,
        cancelled: restoredSession.cancelled,
        showed_up: restoredSession.showed_up,
        was_paid: restoredSession.was_paid,
        payment_method: restoredSession.payment_method,
      });
      setUndoStateBySession((prev) => {
        const next = { ...prev };
        delete next[undoKey];
        return next;
      });
    } catch (error) {
      console.error('Failed to undo session status change:', error);
    } finally {
      setUndoInProgressKey(null);
    }
  };

  const openEditDialog = async (session: SessionRow, type: 'first' | 'regular') => {
    const [playersRes, parentRes] = await Promise.all([
      fetch(`/api/parents/${session.parent_id}/players`),
      fetch(`/api/parents/${session.parent_id}`),
    ]);

    if (playersRes.ok) {
      const players = await playersRes.json();
      setAvailablePlayers(players);
    }

    let liveParentEmail = '';
    if (parentRes.ok) {
      const parent = await parentRes.json();
      liveParentEmail = typeof parent?.email === 'string' ? parent.email.trim() : '';
    }

    setEditForm({
      title: session.title || '',
      session_date: toDatetimeLocal(session.session_date),
      session_end_date: session.session_end_date ? toDatetimeLocal(session.session_end_date) : '',
      location: session.location || '',
      price: session.price?.toString() || '',
      notes: '',
      guest_emails: (session.guest_emails && session.guest_emails.length > 0)
        ? session.guest_emails.join(', ')
        : (session.parent_email || liveParentEmail || ''),
      send_email_updates: session.send_email_updates === true,
      player_ids: session.player_ids || [],
      coach_id: session.coach_id != null ? String(session.coach_id) : '',
    });
    setEditDialog({ session, type });
  };

  const handleEdit = async () => {
    if (!editDialog) return;
    const { session, type } = editDialog;
    const endpoint = type === 'first'
      ? `/api/first-sessions/${session.id}`
      : `/api/sessions/${session.id}`;

    const sessionPayload: Record<string, unknown> = {
      session_date: editForm.session_date,
      session_end_date: editForm.session_end_date || null,
      title: editForm.title.trim() || null,
      location: editForm.location.trim() || null,
      price: editForm.price ? parseFloat(editForm.price) : null,
      guest_emails: editForm.guest_emails
        .split(/[,\n;]+/)
        .map((email) => email.trim())
        .filter(Boolean),
      send_email_updates: editForm.send_email_updates,
    };
    sessionPayload.coach_id = editForm.coach_id ? parseInt(editForm.coach_id) : null;

    await fetch(endpoint, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessionPayload),
    });

    // Update players
    const playersEndpoint = type === 'first'
      ? `/api/first-sessions/${session.id}/players`
      : `/api/sessions/${session.id}/players`;
    
    await fetch(playersEndpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        player_ids: editForm.player_ids,
      }),
    });

    setEditDialog(null);
    fetchSessions();
  };

  const allSessions = [
    ...firstSessions.map((s) => ({ ...s, sessionType: 'first' as const })),
    ...regularSessions.map((s) => ({ ...s, sessionType: 'regular' as const })),
  ];

  const isClosedSession = (session: { status?: string; cancelled: boolean; showed_up: boolean | null }) => {
    const status = (session.status || '').toLowerCase();
    return (
      session.cancelled ||
      status === 'cancelled' ||
      status === 'completed' ||
      status === 'no_show' ||
      session.showed_up !== null
    );
  };

  // Split into upcoming and past sessions (compare in Arizona time)
  const now = new Date();
  const upcomingSessions = allSessions
    .filter((s) => new Date(s.session_date) > now && !isClosedSession(s))
    .sort((a, b) => new Date(a.session_date).getTime() - new Date(b.session_date).getTime()); // Earliest first

  const pendingCompletionSessions = allSessions
    .filter((s) => new Date(s.session_date) <= now && !isClosedSession(s))
    .sort((a, b) => new Date(b.session_date).getTime() - new Date(a.session_date).getTime()); // Most recent first

  const pastSessions = allSessions
    .filter((s) => isClosedSession(s))
    .sort((a, b) => new Date(b.session_date).getTime() - new Date(a.session_date).getTime()); // Most recent first

  if (loading) return <Typography color="text.secondary">Loading...</Typography>;

  if (allSessions.length === 0) {
    return (
      <Card>
        <CardContent sx={{ textAlign: 'center', py: 6 }}>
          <Typography color="text.secondary">No sessions yet. Book your first one!</Typography>
        </CardContent>
      </Card>
    );
  }

  const renderSession = (session: typeof allSessions[0]) => {
    const undoKey = getUndoKey(session.id, session.sessionType);
    const rowUndoInProgress = undoInProgressKey === undoKey;

    const canComplete =
      !session.cancelled &&
      session.status !== 'cancelled' &&
      session.status !== 'no_show' &&
      session.status !== 'completed' &&
      session.showed_up === null &&
      new Date(session.session_date) <= new Date();

    // Determine background color based on status
    const getBackgroundColor = () => {
      if (session.status === 'accepted') return 'success.50';
      if (session.status === 'cancelled') return 'error.50';
      if (session.status === 'rescheduled') return 'warning.50';
      if (session.status === 'no_show') return 'error.100';
      if (session.status === 'completed') return 'success.100';
      return 'background.paper';
    };

    return (
            <Card key={`${session.sessionType}-${session.id}`} sx={{ bgcolor: getBackgroundColor() }}>
              <CardContent sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Box>
                  <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 0.5 }}>
                    <Typography sx={{ fontWeight: 600 }}>
                      {session.title?.trim() || session.parent_name}
                    </Typography>
                    {session.player_names && session.player_names.length > 0 && (
                      <Typography variant="body2" color="text.secondary">
                        ({session.player_names.join(', ')})
                      </Typography>
                    )}
                    {session.sessionType === 'first' && (
                      <Chip label="First Session" size="small" color="primary" />
                    )}
                    {session.status && session.status !== 'scheduled' && (
                      <Chip 
                        label={session.status.replace('_', ' ')} 
                        size="small" 
                        color={session.status === 'accepted' ? 'success' : session.status === 'cancelled' ? 'error' : 'warning'}
                      />
                    )}
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    Parent: {session.parent_name} — {' '}
                    {formatArizonaDateTime(session.session_date)}
                    {session.session_end_date && ` to ${formatArizonaDateTime(session.session_end_date)}`}
                    {session.location && ` — ${session.location}`}
                    {session.price && ` — $${session.price}`}
                  </Typography>
                  {session.guest_emails && session.guest_emails.length > 0 && (
                    <Typography variant="body2" color="text.secondary">
                      Guests: {session.guest_emails.join(', ')}
                    </Typography>
                  )}
                  <Typography variant="body2" color="text.secondary">
                    Email Updates: {session.send_email_updates ? 'On' : 'Off'}
                  </Typography>
                  <Typography variant="body2" color={session.coach_name ? 'text.secondary' : 'warning.main'}>
                    Coach: {session.coach_name || 'Not assigned'}
                  </Typography>
                  {session.sessionType === 'first' && session.deposit_paid && (
                    <Typography variant="body2" color="primary.main">
                      Deposit: ${session.deposit_amount || 'Paid'}
                    </Typography>
                  )}
                </Box>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {session.showed_up === true && <Chip label="Showed Up" color="success" size="small" />}
                  {session.cancelled && <Chip label="Cancelled" color="error" size="small" />}
                  {session.was_paid && <Chip label={`Paid (${session.payment_method})`} size="small" variant="outlined" />}
                  {/* Show action buttons for all sessions (upcoming and past) */}
                  <Button 
                    size="small" 
                    variant="outlined" 
                    startIcon={<EditIcon />}
                    onClick={() => openEditDialog(session, session.sessionType)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="small"
                    variant="contained"
                    color="success"
                    startIcon={<CheckIcon />}
                    onClick={() => openComplete(session, session.sessionType)}
                    disabled={!canComplete}
                  >
                    Complete
                  </Button>
                  <Button 
                    size="small" 
                    variant="outlined" 
                    color="success" 
                    startIcon={<EventAvailableIcon />}
                    onClick={() => updateSessionStatus(session.id, session.sessionType, 'accept')}
                  >
                    Accept
                  </Button>
                  <Button 
                    size="small" 
                    variant="outlined" 
                    color="warning" 
                    startIcon={<EventRepeatIcon />}
                    onClick={() => updateSessionStatus(session.id, session.sessionType, 'reschedule')}
                  >
                    Reschedule
                  </Button>
                  <Button 
                    size="small" 
                    variant="outlined" 
                    color="error" 
                    startIcon={<CancelIcon />}
                    onClick={() => updateSessionStatus(session.id, session.sessionType, 'cancel')}
                  >
                    Cancel
                  </Button>
                  <Button 
                    size="small" 
                    variant="outlined" 
                    color="error" 
                    startIcon={<EventBusyIcon />}
                    onClick={() => updateSessionStatus(session.id, session.sessionType, 'no-show')}
                  >
                    No Show
                  </Button>
                  <Button
                    size="small"
                    variant="contained"
                    color="info"
                    startIcon={<UndoIcon />}
                    onClick={() => handleUndoStatus(session)}
                    disabled={rowUndoInProgress}
                  >
                    {rowUndoInProgress ? 'Undoing...' : 'Undo'}
                  </Button>
                </Box>
              </CardContent>
            </Card>
    );
  };

  return (
    <Box>
      {/* Upcoming Sessions */}
      {upcomingSessions.length > 0 && (
        <Box sx={{ mb: 4 }}>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
            Upcoming Sessions ({upcomingSessions.length})
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {upcomingSessions.map((session) => renderSession(session))}
          </Box>
        </Box>
      )}

      {/* Pending Completion */}
      {pendingCompletionSessions.length > 0 && (
        <Box sx={{ mb: 4 }}>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
            Pending Completion ({pendingCompletionSessions.length})
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {pendingCompletionSessions.map((session) => renderSession(session))}
          </Box>
        </Box>
      )}

      {/* Past Sessions */}
      {pastSessions.length > 0 && (
        <Box>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>
            Past Sessions ({pastSessions.length})
          </Typography>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {pastSessions.map((session) => renderSession(session))}
          </Box>
        </Box>
      )}

      {/* Complete Session Dialog */}
      <Dialog open={!!completeDialog} onClose={() => setCompleteDialog(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Complete Session</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
            <FormControlLabel
              control={<Checkbox checked={showedUp} onChange={(e) => { setShowedUp(e.target.checked); if (e.target.checked) setCancelled(false); }} />}
              label="Showed Up"
            />
            <FormControlLabel
              control={<Checkbox checked={cancelled} onChange={(e) => { setCancelled(e.target.checked); if (e.target.checked) setShowedUp(false); }} />}
              label="Cancelled"
            />
            <FormControlLabel
              control={<Checkbox checked={wasPaid} onChange={(e) => setWasPaid(e.target.checked)} />}
              label="Was Paid"
            />
            {wasPaid && (
              <TextField
                label="Payment Method"
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
                select
                fullWidth
              >
                <MenuItem value="zelle">Zelle</MenuItem>
                <MenuItem value="venmo">Venmo</MenuItem>
                <MenuItem value="paypal">PayPal</MenuItem>
                <MenuItem value="apple_cash">Apple Cash</MenuItem>
                <MenuItem value="cash">Cash</MenuItem>
              </TextField>
            )}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCompleteDialog(null)}>Cancel</Button>
          <Button onClick={handleComplete} variant="contained">Save</Button>
        </DialogActions>
      </Dialog>

      {/* Edit Session Dialog */}
      <Dialog open={!!editDialog} onClose={() => setEditDialog(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Edit Session</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
            <TextField
              label="Session Title"
              fullWidth
              value={editForm.title}
              onChange={(e) => setEditForm({ ...editForm, title: e.target.value })}
            />
            <TextField
              label="Session Date/Time"
              type="datetime-local"
              fullWidth
              value={editForm.session_date}
              onChange={(e) => setEditForm({ ...editForm, session_date: e.target.value })}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              label="Session End Time"
              type="datetime-local"
              fullWidth
              value={editForm.session_end_date}
              onChange={(e) => setEditForm({ ...editForm, session_end_date: e.target.value })}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <GooglePlacesTextField
              label="Location"
              fullWidth
              value={editForm.location}
              onValueChange={(value) => setEditForm({ ...editForm, location: value })}
            />
            <TextField
              label="Guest Emails (comma separated)"
              fullWidth
              value={editForm.guest_emails}
              onChange={(e) => setEditForm({ ...editForm, guest_emails: e.target.value })}
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={editForm.send_email_updates}
                  onChange={(e) =>
                    setEditForm({ ...editForm, send_email_updates: e.target.checked })
                  }
                />
              }
              label="Send Google email updates to guests"
            />
            <TextField
              label="Price ($)"
              type="number"
              fullWidth
              value={editForm.price}
              onChange={(e) => setEditForm({ ...editForm, price: e.target.value })}
            />
            {availablePlayers.length > 0 && (
              <TextField
                label="Players (select multiple)"
                select
                fullWidth
                SelectProps={{ 
                  multiple: true,
                  value: editForm.player_ids,
                  onChange: (e) => setEditForm({ ...editForm, player_ids: e.target.value as unknown as number[] })
                }}
              >
                {availablePlayers.map((player) => (
                  <MenuItem key={player.id} value={player.id}>{player.name}</MenuItem>
                ))}
              </TextField>
            )}
            <TextField
              label="Coach"
              select
              fullWidth
              value={editForm.coach_id}
              onChange={(e) => setEditForm({ ...editForm, coach_id: e.target.value })}
              error={!editForm.coach_id}
              helperText={editForm.coach_id ? 'Every session should have a coach.' : 'No coach assigned — please pick one.'}
            >
              <MenuItem value="">— None —</MenuItem>
              {staff.map((s) => (
                <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>
              ))}
            </TextField>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditDialog(null)}>Cancel</Button>
          <Button onClick={handleEdit} variant="contained">Save</Button>
        </DialogActions>
      </Dialog>

    </Box>
  );
}
