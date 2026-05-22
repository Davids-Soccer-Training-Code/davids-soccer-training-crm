'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Stepper from '@mui/material/Stepper';
import Step from '@mui/material/Step';
import StepLabel from '@mui/material/StepLabel';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import AddIcon from '@mui/icons-material/Add';
import FormControlLabel from '@mui/material/FormControlLabel';
import Switch from '@mui/material/Switch';
import EventIcon from '@mui/icons-material/Event';
import CheckIcon from '@mui/icons-material/Check';
import NotificationsIcon from '@mui/icons-material/Notifications';
import { formatArizonaDate, formatArizonaDateTime, toDateInput } from '@/lib/timezone';
import type { Gender, ParentDetail, Player } from '@/lib/types';
import GooglePlacesTextField from '@/components/common/GooglePlacesTextField';

const dmSteps = [
  { value: 'first_message', label: 'First Message' },
  { value: 'started_talking', label: 'Started Talking' },
  { value: 'request_phone_call', label: 'Request Call' },
];

const reminderCategoryLabels: Record<string, string> = {
  session_reminder: 'Session Reminder',
};

const reminderTypeLabels: Record<string, string> = {
  session_48h: '48h before',
  session_24h: '24h before',
  session_6h: '6h before',
  session_start: 'At session time',
  coach_session_start: 'Coach at start',
  coach_session_plus_60m: 'Coach +60m',
  parent_session_plus_120m: 'Parent +3h after end',
};

type EditableParentField = 'name' | 'secondary_parent_name' | 'phone' | 'email' | 'instagram_link' | 'notes';

function normalizeBirthdayInput(value: string | null | undefined): string {
  return value ? String(value).slice(0, 10) : '';
}

function formatBirthdayDisplay(value: string | null | undefined): string | null {
  if (!value) return null;
  const parts = String(value).slice(0, 10).split('-');
  if (parts.length !== 3) return String(value).slice(0, 10);
  return `${parts[1]}/${parts[2]}/${parts[0]}`;
}

function addOneHour(datetimeLocal: string): string {
  const start = new Date(datetimeLocal);
  if (Number.isNaN(start.getTime())) return '';
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}T${pad(end.getHours())}:${pad(end.getMinutes())}`;
}

export default function ContactDetail({ id }: { id: string }) {
  const router = useRouter();
  const [parent, setParent] = useState<ParentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>('');
  const [savingField, setSavingField] = useState<string | null>(null);
  const [playerDialogOpen, setPlayerDialogOpen] = useState(false);
  const [editingPlayer, setEditingPlayer] = useState<Player | null>(null);
  const [newPlayer, setNewPlayer] = useState({ name: '', age: '', birthday: '', team: '', gender: '' as Gender | '', notes: '' });
  const [firstSessionForm, setFirstSessionForm] = useState({
    player_ids: [] as string[],
    title: '',
    session_date: '',
    session_end_date: '',
    location: '',
    guest_emails: '',
    send_email_updates: false,
    price: '',
    deposit_paid: false,
    deposit_amount: '',
    notes: '',
  });
  const [bookingFirstSession, setBookingFirstSession] = useState(false);

  const fetchParent = useCallback(async () => {
    const res = await fetch(`/api/parents/${id}`);
    if (res.ok) {
      setParent(await res.json());
    }
    setLoading(false);
  }, [id]);

  useEffect(() => {
    fetchParent();
  }, [fetchParent]);

  useEffect(() => {
    if (!parent?.email) return;
    setFirstSessionForm((prev) => {
      if (prev.guest_emails.trim()) return prev;
      return { ...prev, guest_emails: parent.email || '' };
    });
  }, [parent?.email]);

  const updateField = async (field: string, value: unknown) => {
    try {
      const res = await fetch(`/api/parents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
      if (!res.ok) {
        console.error('Failed to update field:', field, 'Status:', res.status);
      }
    } catch (error) {
      console.error('Error updating field:', field, error);
    }
    fetchParent();
    setEditingField(null);
  };

  const startInlineEdit = (field: EditableParentField, currentValue: string | null) => {
    setEditingField(field);
    setEditValue(currentValue ?? '');
  };

  const cancelInlineEdit = () => {
    setEditingField(null);
    setEditValue('');
  };

  const saveInlineEdit = async (field: EditableParentField, required = false) => {
    const trimmed = editValue.trim();
    if (required && !trimmed) return;

    const normalizedValue = required ? trimmed : (trimmed || null);
    setSavingField(field);
    await updateField(field, normalizedValue);
    setSavingField(null);
  };

  const openAddPlayerDialog = () => {
    setEditingPlayer(null);
    setNewPlayer({ name: '', age: '', birthday: '', team: '', gender: '', notes: '' });
    setPlayerDialogOpen(true);
  };

  const openEditPlayerDialog = (player: Player) => {
    setEditingPlayer(player);
    setNewPlayer({
      name: player.name,
      age: player.age != null ? String(player.age) : '',
      birthday: normalizeBirthdayInput(player.birthday),
      team: player.team ?? '',
      gender: player.gender ?? '',
      notes: player.notes ?? '',
    });
    setPlayerDialogOpen(true);
  };

  const savePlayer = async () => {
    if (!newPlayer.name.trim()) return;
    if (editingPlayer) {
      await fetch(`/api/players/${editingPlayer.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newPlayer.name.trim(),
          age: newPlayer.age ? parseInt(newPlayer.age) : null,
          birthday: newPlayer.birthday || null,
          team: newPlayer.team.trim() || null,
          gender: newPlayer.gender || null,
          notes: newPlayer.notes.trim() || null,
        }),
      });
    } else {
      await fetch(`/api/parents/${id}/players`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newPlayer.name.trim(),
          age: newPlayer.age ? parseInt(newPlayer.age) : null,
          birthday: newPlayer.birthday || null,
          team: newPlayer.team.trim() || null,
          gender: newPlayer.gender || null,
          notes: newPlayer.notes.trim() || null,
        }),
      });
    }
    setNewPlayer({ name: '', age: '', birthday: '', team: '', gender: '', notes: '' });
    setEditingPlayer(null);
    setPlayerDialogOpen(false);
    fetchParent();
  };

  const deletePlayer = async (playerId: number) => {
    await fetch(`/api/players/${playerId}`, { method: 'DELETE' });
    fetchParent();
  };

  const deleteContact = async () => {
    if (!confirm('Delete this contact and all their data?')) return;
    await fetch(`/api/parents/${id}`, { method: 'DELETE' });
    router.push('/contacts');
  };

  const toggleDeadStatus = async () => {
    if (parent?.is_dead) {
      await updateField('is_dead', false);
      return;
    }

    const confirmed = confirm('Mark this contact/customer as dead? They will be hidden from active lists and reminders.');
    if (!confirmed) return;
    await updateField('is_dead', true);
  };

  const bookFirstSession = async () => {
    if (!firstSessionForm.session_date || !firstSessionForm.location) return;
    setBookingFirstSession(true);
    try {
      await fetch('/api/first-sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parent_id: parseInt(id),
          player_ids: firstSessionForm.player_ids.map(id => parseInt(id)),
          title: firstSessionForm.title.trim() || null,
          session_date: firstSessionForm.session_date,
          session_end_date: firstSessionForm.session_end_date || addOneHour(firstSessionForm.session_date) || null,
          location: firstSessionForm.location.trim(),
          guest_emails: firstSessionForm.guest_emails
            .split(/[,\n;]+/)
            .map((email) => email.trim())
            .filter(Boolean),
          send_email_updates: firstSessionForm.send_email_updates,
          price: firstSessionForm.price ? parseFloat(firstSessionForm.price) : null,
          deposit_paid: firstSessionForm.deposit_paid,
          deposit_amount: firstSessionForm.deposit_amount ? parseFloat(firstSessionForm.deposit_amount) : null,
          notes: firstSessionForm.notes.trim() || null,
        }),
      });
      setFirstSessionForm({
        player_ids: [],
        title: '',
        session_date: '',
        session_end_date: '',
        location: '',
        guest_emails: parent?.email || '',
        send_email_updates: false,
        price: '',
        deposit_paid: false,
        deposit_amount: '',
        notes: '',
      });
      fetchParent();
    } catch (error) {
      console.error('Error booking first session:', error);
    } finally {
      setBookingFirstSession(false);
    }
  };

  const markReminderSent = async (reminderId: number) => {
    await fetch(`/api/reminders/${reminderId}/mark-sent`, { method: 'POST' });
    fetchParent();
  };

  if (loading) return <Typography>Loading...</Typography>;
  if (!parent) return <Typography>Contact not found.</Typography>;

  const dmStepIndex = parent.dm_status ? dmSteps.findIndex((s) => s.value === parent.dm_status) : -1;
  const isWentCold = parent.dm_status === 'went_cold';
  const editableFields: Array<{
    field: EditableParentField;
    label: string;
    value: string | null;
    required?: boolean;
    type?: 'text' | 'email';
    multiline?: boolean;
  }> = [
    { field: 'name', label: 'Primary Parent Name', value: parent.name, required: true },
    { field: 'secondary_parent_name', label: 'Secondary Parent Name', value: parent.secondary_parent_name },
    { field: 'phone', label: 'Phone', value: parent.phone },
    { field: 'email', label: 'Email', value: parent.email, type: 'email' },
    { field: 'instagram_link', label: 'Instagram Link', value: parent.instagram_link },
    { field: 'notes', label: 'Notes', value: parent.notes, multiline: true },
  ];

  return (
    <Box>
      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', mb: 3 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            {parent.name}
          </Typography>
          {parent.secondary_parent_name && (
            <Typography color="text.secondary">
              Secondary: {parent.secondary_parent_name}
            </Typography>
          )}
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          {parent.is_dead && <Chip label="Dead" color="error" size="small" />}
          <Button
            color={parent.is_dead ? 'success' : 'warning'}
            variant="outlined"
            onClick={toggleDeadStatus}
            size="small"
          >
            {parent.is_dead ? 'Reactivate' : 'Mark Dead'}
          </Button>
          <Button color="error" startIcon={<DeleteIcon />} onClick={deleteContact} size="small">
            Delete
          </Button>
        </Box>
      </Box>

      {/* Contact Info */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>Contact Info</Typography>
          <Box sx={{ display: 'grid', gap: 1.5 }}>
            {editableFields.map((config) => {
              const isEditing = editingField === config.field;
              const displayValue = config.value && config.value.trim().length > 0 ? config.value : 'Not set';
              const isSaving = savingField === config.field;

              return (
                <Box key={config.field} sx={{ p: 1.5, bgcolor: 'grey.50', borderRadius: 2 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>
                    {config.label}
                  </Typography>

                  {isEditing ? (
                    <>
                      <TextField
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        type={config.type || 'text'}
                        size="small"
                        fullWidth
                        autoFocus
                        multiline={config.multiline}
                        minRows={config.multiline ? 3 : undefined}
                      />
                      <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
                        <Button
                          size="small"
                          variant="contained"
                          onClick={() => saveInlineEdit(config.field, config.required)}
                          disabled={isSaving || (config.required && !editValue.trim())}
                        >
                          {isSaving ? 'Saving...' : 'Save'}
                        </Button>
                        <Button size="small" onClick={cancelInlineEdit} disabled={isSaving}>
                          Cancel
                        </Button>
                      </Box>
                    </>
                  ) : (
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: config.multiline ? 'flex-start' : 'center', gap: 1 }}>
                      <Typography
                        color={displayValue === 'Not set' ? 'text.secondary' : 'text.primary'}
                        sx={{ whiteSpace: config.multiline ? 'pre-wrap' : 'normal' }}
                      >
                        {displayValue}
                      </Typography>
                      <IconButton size="small" onClick={() => startInlineEdit(config.field, config.value)} title={`Edit ${config.label}`}>
                        <EditIcon fontSize="small" />
                      </IconButton>
                    </Box>
                  )}
                </Box>
              );
            })}
          </Box>
        </CardContent>
      </Card>

      {/* DM Status Pipeline */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>DM Pipeline</Typography>
            {isWentCold && <Chip label="Went Cold" color="error" size="small" />}
          </Box>
          <Stepper activeStep={isWentCold ? -1 : dmStepIndex} alternativeLabel>
            {dmSteps.map((step) => (
              <Step key={step.value} completed={dmStepIndex >= dmSteps.indexOf(step) && !isWentCold}>
                <StepLabel
                  sx={{ cursor: 'pointer' }}
                  onClick={() => updateField('dm_status', step.value)}
                >
                  {step.label}
                </StepLabel>
              </Step>
            ))}
          </Stepper>
          <Box sx={{ display: 'flex', gap: 1, mt: 2, justifyContent: 'center' }}>
            {!isWentCold && (
              <Button size="small" color="error" variant="outlined" onClick={() => updateField('dm_status', 'went_cold')}>
                Mark Went Cold
              </Button>
            )}
            {isWentCold && (
              <Button size="small" color="primary" variant="outlined" onClick={() => updateField('dm_status', 'first_message')}>
                Reactivate
              </Button>
            )}
          </Box>
        </CardContent>
      </Card>

      {/* Phone Call Tracking */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>Phone Call</Typography>
          <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'center' }}>
            <Button
              variant={parent.phone_call_booked ? 'contained' : 'outlined'}
              onClick={() => updateField('phone_call_booked', !parent.phone_call_booked)}
            >
              {parent.phone_call_booked ? 'Call Booked' : 'Book a Call'}
            </Button>
            {parent.phone_call_booked && (
              <>
                <TextField
                  label="Call Date"
                  type="date"
                  size="small"
                  value={parent.call_date_time ? toDateInput(parent.call_date_time) : ''}
                  onChange={(e) => updateField('call_date_time', e.target.value || null)}
                  slotProps={{ inputLabel: { shrink: true } }}
                />
                <TextField
                  label="Call Outcome"
                  select
                  size="small"
                  sx={{ minWidth: 180 }}
                  value={parent.call_outcome || ''}
                  onChange={(e) => updateField('call_outcome', e.target.value || null)}
                >
                  <MenuItem value="">--</MenuItem>
                  <MenuItem value="session_booked">Session Booked</MenuItem>
                  <MenuItem value="thinking_about_it">Thinking About It</MenuItem>
                  <MenuItem value="uninterested">Uninterested</MenuItem>
                  <MenuItem value="went_cold">Went Cold</MenuItem>
                </TextField>
              </>
            )}
          </Box>
        </CardContent>
      </Card>

      {/* Book First Session — appears when call outcome is session_booked and no first session exists */}
      {parent.call_outcome === 'session_booked' && !parent.first_session && (
        <Card sx={{ mb: 3, border: 2, borderColor: 'success.main' }}>
          <CardContent>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
              <EventIcon color="success" />
              <Typography variant="h6" sx={{ fontWeight: 600 }}>Book First Session</Typography>
            </Box>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
              <TextField
                label="Session Date/Time *"
                type="datetime-local"
                size="small"
                fullWidth
                value={firstSessionForm.session_date}
                onChange={(e) =>
                  setFirstSessionForm((prev) => {
                    const nextStart = e.target.value;
                    return {
                      ...prev,
                      session_date: nextStart,
                      session_end_date:
                        !prev.session_end_date || prev.session_end_date <= nextStart
                          ? addOneHour(nextStart)
                          : prev.session_end_date,
                    };
                  })
                }
                slotProps={{ inputLabel: { shrink: true } }}
              />
              <TextField
                label="Session End Time *"
                type="datetime-local"
                size="small"
                fullWidth
                value={firstSessionForm.session_end_date}
                onChange={(e) => setFirstSessionForm({ ...firstSessionForm, session_end_date: e.target.value })}
                slotProps={{ inputLabel: { shrink: true } }}
              />
              <TextField
                label="Session Title"
                size="small"
                fullWidth
                value={firstSessionForm.title}
                onChange={(e) => setFirstSessionForm({ ...firstSessionForm, title: e.target.value })}
              />
              <GooglePlacesTextField
                label="Location *"
                size="small"
                fullWidth
                value={firstSessionForm.location}
                onValueChange={(value) => setFirstSessionForm({ ...firstSessionForm, location: value })}
              />
              <TextField
                label="Guest Emails (comma separated)"
                size="small"
                fullWidth
                value={firstSessionForm.guest_emails}
                onChange={(e) => setFirstSessionForm({ ...firstSessionForm, guest_emails: e.target.value })}
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={firstSessionForm.send_email_updates}
                    onChange={(e) =>
                      setFirstSessionForm({ ...firstSessionForm, send_email_updates: e.target.checked })
                    }
                  />
                }
                label="Send Google email updates to guests"
              />
              {parent.players && parent.players.length > 0 && (
                <TextField
                  label="Players (select multiple)"
                  select
                  size="small"
                  fullWidth
                  SelectProps={{ multiple: true }}
                  value={firstSessionForm.player_ids}
                  onChange={(e) => setFirstSessionForm({ ...firstSessionForm, player_ids: e.target.value as unknown as string[] })}
                >
                  {parent.players.map((p) => (
                    <MenuItem key={p.id} value={String(p.id)}>{p.name}</MenuItem>
                  ))}
                </TextField>
              )}
              <TextField
                label="Price ($)"
                type="number"
                size="small"
                fullWidth
                value={firstSessionForm.price}
                onChange={(e) => setFirstSessionForm({ ...firstSessionForm, price: e.target.value })}
              />
              <FormControlLabel
                control={
                  <Switch
                    checked={firstSessionForm.deposit_paid}
                    onChange={(e) => setFirstSessionForm({ ...firstSessionForm, deposit_paid: e.target.checked })}
                  />
                }
                label="Deposit Paid"
              />
              {firstSessionForm.deposit_paid && (
                <TextField
                  label="Deposit Amount ($)"
                  type="number"
                  size="small"
                  fullWidth
                  value={firstSessionForm.deposit_amount}
                  onChange={(e) => setFirstSessionForm({ ...firstSessionForm, deposit_amount: e.target.value })}
                />
              )}
            </Box>
            <TextField
              label="Notes"
              size="small"
              fullWidth
              value={firstSessionForm.notes}
              onChange={(e) => setFirstSessionForm({ ...firstSessionForm, notes: e.target.value })}
              sx={{ mt: 2 }}
            />
            <Box sx={{ mt: 2, display: 'flex', gap: 2 }}>
              <Button
                variant="contained"
                color="success"
                onClick={bookFirstSession}
                disabled={
                  bookingFirstSession ||
                  !firstSessionForm.session_date ||
                  !firstSessionForm.session_end_date ||
                  !firstSessionForm.location.trim()
                }
              >
                {bookingFirstSession ? 'Booking...' : 'Book First Session'}
              </Button>
            </Box>
          </CardContent>
        </Card>
      )}

      {/* Players */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Players ({parent.players?.length || 0})
            </Typography>
            <Button startIcon={<AddIcon />} onClick={openAddPlayerDialog} size="small">
              Add Player
            </Button>
          </Box>
          {parent.players && parent.players.length > 0 ? (
            parent.players.map((player: Player) => (
              <Box
                key={player.id}
                sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', p: 2, bgcolor: 'grey.50', borderRadius: 2, mb: 1 }}
              >
                <Box>
                  <Typography sx={{ fontWeight: 600 }}>{player.name}</Typography>
                  <Typography variant="body2" color="text.secondary">
                    {[player.age && `Age ${player.age}`, formatBirthdayDisplay(player.birthday) && `Birthday ${formatBirthdayDisplay(player.birthday)}`, player.team, player.gender].filter(Boolean).join(' · ')}
                  </Typography>
                  {player.notes && (
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{player.notes}</Typography>
                  )}
                </Box>
                <Box sx={{ display: 'flex', gap: 0.5 }}>
                  <IconButton size="small" onClick={() => openEditPlayerDialog(player)} title="Edit player">
                    <EditIcon fontSize="small" />
                  </IconButton>
                  <IconButton size="small" color="error" onClick={() => deletePlayer(player.id)}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Box>
              </Box>
            ))
          ) : (
            <Typography color="text.secondary">No players yet.</Typography>
          )}
        </CardContent>
      </Card>

      {/* Active Package */}
      {parent.active_package && (
        <Card sx={{ mb: 3, border: 2, borderColor: 'success.main' }}>
          <CardContent>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
              <Typography variant="h6" sx={{ fontWeight: 600 }}>Active Package</Typography>
              <Button size="small" variant="outlined" onClick={() => parent.active_package && router.push(`/packages/${parent.active_package.id}`)}>
                View Details
              </Button>
            </Box>
            <Typography variant="body1" sx={{ fontWeight: 600, mb: 1 }}>
              {parent.active_package.package_type.replace('_', ' ').toUpperCase()}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Progress: {parent.active_package.sessions_completed} / {parent.active_package.total_sessions} sessions
            </Typography>
            {parent.active_package.price && (
              <Typography variant="body2" color="text.secondary">
                Price: ${parent.active_package.price}
              </Typography>
            )}
            {parent.active_package.start_date && (
              <Typography variant="body2" color="text.secondary">
                Started: {formatArizonaDate(parent.active_package.start_date)}
              </Typography>
            )}
          </CardContent>
        </Card>
      )}

      {/* Session History */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 2 }}>Session History</Typography>
          {parent.first_session && (
            <Box sx={{ p: 2, bgcolor: 'grey.50', borderRadius: 2, mb: 1 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
                <Typography sx={{ fontWeight: 600 }}>First Session</Typography>
                <Box sx={{ display: 'flex', gap: 1 }}>
                  {parent.first_session.status && (
                    <Chip
                      label={parent.first_session.status.replace('_', ' ')}
                      color={
                        parent.first_session.status === 'accepted' ? 'success' :
                        parent.first_session.status === 'completed' ? 'success' :
                        parent.first_session.status === 'cancelled' ? 'error' : 'warning'
                      }
                      size="small"
                    />
                  )}
                  {!parent.first_session.status && (
                    <Chip
                      label={parent.first_session.showed_up === true ? 'Showed Up' : parent.first_session.cancelled ? 'Cancelled' : 'Upcoming'}
                      color={parent.first_session.showed_up ? 'success' : parent.first_session.cancelled ? 'error' : 'info'}
                      size="small"
                    />
                  )}
                </Box>
              </Box>
              <Typography variant="body2" color="text.secondary">
                {formatArizonaDateTime(parent.first_session.session_date)} — {parent.first_session.location}
                {parent.first_session.price && ` — $${parent.first_session.price}`}
              </Typography>
            </Box>
          )}
          {parent.sessions && parent.sessions.length > 0 ? (
            parent.sessions.map((session) => (
              <Box key={session.id} sx={{ p: 2, bgcolor: 'grey.50', borderRadius: 2, mb: 1 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
                  <Typography sx={{ fontWeight: 600 }}>
                    {formatArizonaDateTime(session.session_date)}
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 1 }}>
                    {session.status && (
                      <Chip
                        label={session.status.replace('_', ' ')}
                        color={
                          session.status === 'accepted' ? 'success' :
                          session.status === 'completed' ? 'success' :
                          session.status === 'cancelled' ? 'error' : 'warning'
                        }
                        size="small"
                      />
                    )}
                    {!session.status && (
                      <Chip
                        label={session.showed_up === true ? 'Showed Up' : session.cancelled ? 'Cancelled' : 'Upcoming'}
                        color={session.showed_up ? 'success' : session.cancelled ? 'error' : 'info'}
                        size="small"
                      />
                    )}
                  </Box>
                </Box>
                <Typography variant="body2" color="text.secondary">
                  {session.location}{session.price && ` — $${session.price}`}
                  {session.was_paid && ` — Paid (${session.payment_method})`}
                </Typography>
              </Box>
            ))
          ) : (
            !parent.first_session && <Typography color="text.secondary">No sessions yet.</Typography>
          )}
        </CardContent>
      </Card>

      {/* Pending Session Texts */}
      {parent.pending_reminders && parent.pending_reminders.length > 0 && (() => {
        const sessionReminders = parent.pending_reminders.filter(
          (r) => r.reminder_category === 'session_reminder'
        );
        if (sessionReminders.length === 0) return null;

        return (
          <Card sx={{ mb: 3 }}>
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
                <NotificationsIcon color="warning" />
                <Typography variant="h6" sx={{ fontWeight: 600 }}>
                  Pending Session Texts ({sessionReminders.length})
                </Typography>
              </Box>

              {sessionReminders.length > 0 && (
                <>
                  <Typography variant="subtitle2" sx={{ mb: 1, color: '#9c27b0', fontWeight: 600 }}>
                    Session Reminders
                  </Typography>
                  {sessionReminders.map((reminder) => (
                    <Box
                      key={reminder.id}
                      sx={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        p: 1.5,
                        bgcolor: 'grey.50',
                        borderRadius: 2,
                        mb: 1,
                        borderLeft: '4px solid #9c27b0',
                      }}
                    >
                      <Box>
                        <Typography sx={{ fontWeight: 600 }}>
                          {reminderCategoryLabels[reminder.reminder_category] || reminder.reminder_category}
                        </Typography>
                        <Typography variant="body2" color="text.secondary">
                          {reminderTypeLabels[reminder.reminder_type] || reminder.reminder_type}
                          {' — Due: '}
                          {formatArizonaDateTime(reminder.due_at)}
                        </Typography>
                      </Box>
                      <IconButton color="success" onClick={() => markReminderSent(reminder.id)} title="Mark as sent">
                        <CheckIcon />
                      </IconButton>
                    </Box>
                  ))}
                </>
              )}
            </CardContent>
          </Card>
        );
      })()}

      {/* Add / Edit Player Dialog */}
      <Dialog open={playerDialogOpen} onClose={() => { setPlayerDialogOpen(false); setEditingPlayer(null); }} maxWidth="sm" fullWidth>
        <DialogTitle>{editingPlayer ? 'Edit Player' : 'Add Player'}</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2, mt: 1 }}>
            <TextField label="Name *" value={newPlayer.name} onChange={(e) => setNewPlayer({ ...newPlayer, name: e.target.value })} fullWidth />
            <TextField label="Age" value={newPlayer.age} onChange={(e) => setNewPlayer({ ...newPlayer, age: e.target.value })} type="number" fullWidth />
            <TextField
              label="Birthday"
              value={newPlayer.birthday}
              onChange={(e) => setNewPlayer({ ...newPlayer, birthday: e.target.value })}
              type="date"
              fullWidth
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField label="Team" value={newPlayer.team} onChange={(e) => setNewPlayer({ ...newPlayer, team: e.target.value })} fullWidth />
            <TextField label="Gender" value={newPlayer.gender} onChange={(e) => setNewPlayer({ ...newPlayer, gender: e.target.value as Gender })} select fullWidth>
              <MenuItem value="">--</MenuItem>
              <MenuItem value="male">Male</MenuItem>
              <MenuItem value="female">Female</MenuItem>
              <MenuItem value="other">Other</MenuItem>
            </TextField>
          </Box>
          <TextField label="Notes" value={newPlayer.notes} onChange={(e) => setNewPlayer({ ...newPlayer, notes: e.target.value })} fullWidth sx={{ mt: 2 }} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => { setPlayerDialogOpen(false); setEditingPlayer(null); }}>Cancel</Button>
          <Button onClick={savePlayer} variant="contained" disabled={!newPlayer.name.trim()}>
            {editingPlayer ? 'Save' : 'Add'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
