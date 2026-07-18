'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Button from '@mui/material/Button';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import CheckIcon from '@mui/icons-material/Check';
import PhoneIcon from '@mui/icons-material/Phone';
import EventIcon from '@mui/icons-material/Event';
import NotificationsIcon from '@mui/icons-material/Notifications';
import PeopleIcon from '@mui/icons-material/People';
import AttachMoneyIcon from '@mui/icons-material/AttachMoney';
import CancelIcon from '@mui/icons-material/Cancel';
import EventRepeatIcon from '@mui/icons-material/EventRepeat';
import EventBusyIcon from '@mui/icons-material/EventBusy';
import EventAvailableIcon from '@mui/icons-material/EventAvailable';
import EditIcon from '@mui/icons-material/Edit';
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth';
import ViewListIcon from '@mui/icons-material/ViewList';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import CalendarView from '@/components/dashboard/CalendarView';
import { formatArizonaDate, formatArizonaTime, nowInArizona, toDatetimeLocal } from '@/lib/timezone';

const reminderTypeLabels: Record<string, string> = {
  session_48h: '48h before',
  session_24h: '24h before',
  session_6h: '6h before',
  session_start: 'At session time',
  coach_session_start: 'Coach at start',
  coach_session_plus_60m: 'Coach +60m',
  parent_session_plus_120m: 'Parent +3h after end',
};

const DAY_OFFSET_MIN = -30;
const DAY_OFFSET_MAX = 30;

interface DashboardData {
  todays_calls: Array<{ id: number; name: string; call_date_time: string | null; phone: string }>;
  todays_first_sessions: Array<{ id: number; parent_id: number; parent_name: string; player_names: string[] | null; player_ids: number[] | null; session_date: string; location: string | null; price: number | null; status: string }>;
  todays_sessions: Array<{ id: number; parent_id: number; parent_name: string; player_names: string[] | null; player_ids: number[] | null; session_date: string; location: string | null; price: number | null; status: string; coach_id: number | null; coach_name: string | null }>;
  pending_reminders: Array<{ id: number; parent_name: string; parent_id: number; reminder_type: string; reminder_category: string; due_at: string; due_days_ago?: number; parent_dm_status: string | null; player_names: string[] | null }>;
  stats: { total_contacts: number; sessions_this_week: number; revenue_this_month: number };
  selected_day_offset?: number;
}

interface Player {
  id: number;
  name: string;
}

type DashboardSession =
  | DashboardData['todays_first_sessions'][number]
  | DashboardData['todays_sessions'][number];

export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState<'list' | 'calendar'>('list');
  const [dayOffset, setDayOffset] = useState(0);
  const [editDialog, setEditDialog] = useState<{ id: number; parent_id: number; type: 'first' | 'regular' } | null>(null);
  const [editForm, setEditForm] = useState({
    session_date: '',
    location: '',
    price: '',
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

  const fetchDashboard = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/dashboard?dayOffset=${dayOffset}`);
    if (res.ok) setData(await res.json());
    setLoading(false);
  }, [dayOffset]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      fetchDashboard();
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, [fetchDashboard]);

  const markReminderSent = async (id: number) => {
    await fetch(`/api/reminders/${id}/mark-sent`, { method: 'POST' });
    fetchDashboard();
  };

  const updateFirstSessionStatus = async (id: number, action: 'accept' | 'cancel' | 'reschedule' | 'no-show') => {
    await fetch(`/api/first-sessions/${id}/${action}`, { method: 'POST' });
    
    // Update locally without refetching to prevent scroll jump
    const statusMap = {
      accept: 'accepted',
      cancel: 'cancelled',
      reschedule: 'rescheduled',
      'no-show': 'no_show'
    };
    
    setData(prev => prev ? {
      ...prev,
      todays_first_sessions: prev.todays_first_sessions.map(s =>
        s.id === id ? { ...s, status: statusMap[action] } : s
      )
    } : null);
  };

  const updateSessionStatus = async (id: number, action: 'accept' | 'cancel' | 'reschedule' | 'no-show') => {
    await fetch(`/api/sessions/${id}/${action}`, { method: 'POST' });
    
    // Update locally without refetching to prevent scroll jump
    const statusMap = {
      accept: 'accepted',
      cancel: 'cancelled',
      reschedule: 'rescheduled',
      'no-show': 'no_show'
    };
    
    setData(prev => prev ? {
      ...prev,
      todays_sessions: prev.todays_sessions.map(s =>
        s.id === id ? { ...s, status: statusMap[action] } : s
      )
    } : null);
  };

  const openEditDialog = async (session: DashboardSession, type: 'first' | 'regular') => {
    // Fetch parent's players
    const res = await fetch(`/api/parents/${session.parent_id}/players`);
    if (res.ok) {
      const players = await res.json();
      setAvailablePlayers(players);
    }
    
    const coachId = (session as { coach_id?: number | null }).coach_id;
    setEditForm({
      session_date: toDatetimeLocal(session.session_date),
      location: session.location || '',
      price: session.price?.toString() || '',
      player_ids: session.player_ids || [],
      coach_id: coachId != null ? String(coachId) : '',
    });
    setEditDialog({ id: session.id, parent_id: session.parent_id, type });
  };

  const handleEdit = async () => {
    if (!editDialog) return;
    const { id, type } = editDialog;
    const endpoint = type === 'first'
      ? `/api/first-sessions/${id}`
      : `/api/sessions/${id}`;

    // Update session details
    const patchBody: Record<string, unknown> = {
      session_date: editForm.session_date,
      location: editForm.location.trim() || null,
      price: editForm.price ? parseFloat(editForm.price) : null,
    };
    // Coach only applies to regular sessions
    if (type === 'regular') {
      patchBody.coach_id = editForm.coach_id ? parseInt(editForm.coach_id) : null;
    }
    await fetch(endpoint, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patchBody),
    });

    // Update players
    const playersEndpoint = type === 'first'
      ? `/api/first-sessions/${id}/players`
      : `/api/sessions/${id}/players`;
    
    await fetch(playersEndpoint, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        player_ids: editForm.player_ids,
      }),
    });

    setEditDialog(null);
    fetchDashboard();
  };

  if (loading) return <Typography>Loading dashboard...</Typography>;
  if (!data) return <Typography color="error">Failed to load dashboard.</Typography>;

  const selectedDayDate = nowInArizona();
  selectedDayDate.setDate(selectedDayDate.getDate() + dayOffset);
  const selectedDayLabel = dayOffset === 0
    ? 'Today'
    : dayOffset === -1
      ? 'Yesterday'
    : dayOffset === 1
      ? 'Tomorrow'
      : formatArizonaDate(selectedDayDate);

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: { xs: 'flex-start', sm: 'center' }, gap: 2, mb: 3, flexDirection: { xs: 'column', sm: 'row' } }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            Dashboard
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {selectedDayLabel} schedule, sessions, and session texts.
          </Typography>
        </Box>
        <ToggleButtonGroup
          value={viewMode}
          exclusive
          onChange={(e, newView) => newView && setViewMode(newView)}
          size="small"
        >
          <ToggleButton value="list">
            <ViewListIcon sx={{ mr: 1 }} />
            List
          </ToggleButton>
          <ToggleButton value="calendar">
            <CalendarMonthIcon sx={{ mr: 1 }} />
            Calendar
          </ToggleButton>
        </ToggleButtonGroup>
      </Box>

      {viewMode === 'calendar' ? (
        <CalendarView />
      ) : (
        <>
          {/* Stats Row */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr 1fr' }, gap: 2, mb: 2 }}>
        <Card variant="outlined">
          <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <PeopleIcon sx={{ color: 'primary.main', fontSize: 32 }} />
            <Box>
              <Typography variant="h5" sx={{ fontWeight: 700 }}>{data.stats.total_contacts}</Typography>
              <Typography variant="body2" color="text.secondary">Total Contacts</Typography>
            </Box>
          </CardContent>
        </Card>
        <Card variant="outlined">
          <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <EventIcon sx={{ color: 'primary.main', fontSize: 32 }} />
            <Box>
              <Typography variant="h5" sx={{ fontWeight: 700 }}>{data.stats.sessions_this_week}</Typography>
              <Typography variant="body2" color="text.secondary">Sessions This Week</Typography>
            </Box>
          </CardContent>
        </Card>
        <Card variant="outlined">
          <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
            <AttachMoneyIcon sx={{ color: 'primary.main', fontSize: 32 }} />
            <Box>
              <Typography variant="h5" sx={{ fontWeight: 700 }}>${Number(data.stats.revenue_this_month).toFixed(0)}</Typography>
              <Typography variant="body2" color="text.secondary">Revenue This Month</Typography>
            </Box>
          </CardContent>
        </Card>
      </Box>

      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardContent sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, flexWrap: 'wrap', py: 1.5, '&:last-child': { pb: 1.5 } }}>
          <Box>
            <Typography sx={{ fontWeight: 700 }}>
              {selectedDayLabel}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {formatArizonaDate(selectedDayDate)}
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button
              size="small"
              variant="outlined"
              disabled={dayOffset <= DAY_OFFSET_MIN}
              onClick={() => setDayOffset((prev) => Math.max(DAY_OFFSET_MIN, prev - 1))}
            >
              Previous
            </Button>
            <Button
              size="small"
              variant={dayOffset === 0 ? 'contained' : 'outlined'}
              onClick={() => setDayOffset(0)}
            >
              Today
            </Button>
            <Button
              size="small"
              variant="outlined"
              disabled={dayOffset >= DAY_OFFSET_MAX}
              onClick={() => setDayOffset((prev) => Math.min(DAY_OFFSET_MAX, prev + 1))}
            >
              Next
            </Button>
          </Box>
        </CardContent>
      </Card>

      {/* Selected Day Calls */}
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
            <PhoneIcon sx={{ color: 'primary.main' }} />
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Calls ({data.todays_calls.length}) — {selectedDayLabel}
            </Typography>
          </Box>
          {data.todays_calls.length === 0 ? (
            <Typography color="text.secondary" variant="body2">No calls scheduled for this day.</Typography>
          ) : (
            data.todays_calls.map((call) => (
              <Box key={call.id} sx={{ p: 1.5, bgcolor: 'grey.50', borderRadius: 1, mb: 1, cursor: 'pointer' }} onClick={() => router.push(`/contacts/${call.id}`)}>
                <Typography sx={{ fontWeight: 600 }}>{call.name}</Typography>
                <Typography variant="body2" color="text.secondary">
                  {call.call_date_time ? formatArizonaDate(call.call_date_time) : 'No date set'}
                  {call.phone && ` — ${call.phone}`}
                </Typography>
              </Box>
            ))
          )}
        </CardContent>
      </Card>

      {/* Selected Day Sessions */}
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
            <EventIcon sx={{ color: 'primary.main' }} />
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Sessions ({data.todays_first_sessions.length + data.todays_sessions.length}) — {selectedDayLabel}
            </Typography>
          </Box>
          {data.todays_first_sessions.length === 0 && data.todays_sessions.length === 0 ? (
            <Typography color="text.secondary" variant="body2">No sessions for this day.</Typography>
          ) : (
            <>
              {data.todays_first_sessions.map((s) => {
                // Determine background color based on status
                const getBackgroundColor = () => {
                  if (s.status === 'accepted') return 'success.light';
                  if (s.status === 'cancelled') return 'error.light';
                  if (s.status === 'rescheduled') return 'warning.light';
                  if (s.status === 'no_show') return 'error.dark';
                  if (s.status === 'completed') return 'success.dark';
                  return 'grey.50';
                };
                
                return (
                <Box key={`fs-${s.id}`} sx={{ p: 1.5, bgcolor: getBackgroundColor(), borderRadius: 1, mb: 1 }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
                    <Box>
                      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                        <Typography sx={{ fontWeight: 600 }}>{s.parent_name}</Typography>
                        {s.player_names && s.player_names.length > 0 && (
                          <Typography variant="body2" color="text.secondary">
                            ({s.player_names.join(', ')})
                          </Typography>
                        )}
                        <Chip label="First Session" size="small" color="primary" />
                        {s.status !== 'scheduled' && (
                          <Chip 
                            label={s.status.replace('_', ' ')} 
                            size="small" 
                            color={s.status === 'accepted' ? 'success' : s.status === 'cancelled' ? 'error' : 'warning'}
                          />
                        )}
                      </Box>
                      <Typography variant="body2" color="text.secondary">
                        {formatArizonaTime(s.session_date)}
                        {s.location && ` — ${s.location}`}
                        {s.price && ` — $${s.price}`}
                      </Typography>
                    </Box>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<EditIcon />}
                      onClick={() => openEditDialog(s, 'first')}
                    >
                      Edit
                    </Button>
                    <Button 
                      size="small" 
                      variant="outlined" 
                      color="success" 
                      startIcon={<EventAvailableIcon />}
                      onClick={() => updateFirstSessionStatus(s.id, 'accept')}
                    >
                      Accept
                    </Button>
                    <Button 
                      size="small" 
                      variant="outlined" 
                      color="warning" 
                      startIcon={<EventRepeatIcon />}
                      onClick={() => updateFirstSessionStatus(s.id, 'reschedule')}
                    >
                      Reschedule
                    </Button>
                    <Button 
                      size="small" 
                      variant="outlined" 
                      color="error" 
                      startIcon={<CancelIcon />}
                      onClick={() => updateFirstSessionStatus(s.id, 'cancel')}
                    >
                      Cancel
                    </Button>
                    <Button 
                      size="small" 
                      variant="outlined" 
                      color="error" 
                      startIcon={<EventBusyIcon />}
                      onClick={() => updateFirstSessionStatus(s.id, 'no-show')}
                    >
                      No Show
                    </Button>
                  </Box>
                </Box>
                );
              })}
              {data.todays_sessions.map((s) => {
                // Determine background color based on status
                const getBackgroundColor = () => {
                  if (s.status === 'accepted') return 'success.light';
                  if (s.status === 'cancelled') return 'error.light';
                  if (s.status === 'rescheduled') return 'warning.light';
                  if (s.status === 'no_show') return 'error.dark';
                  if (s.status === 'completed') return 'success.dark';
                  return 'grey.50';
                };
                
                return (
                <Box key={`s-${s.id}`} sx={{ p: 1.5, bgcolor: getBackgroundColor(), borderRadius: 1, mb: 1 }}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
                    <Box>
                      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                        <Typography sx={{ fontWeight: 600 }}>{s.parent_name}</Typography>
                        {s.player_names && s.player_names.length > 0 && (
                          <Typography variant="body2" color="text.secondary">
                            ({s.player_names.join(', ')})
                          </Typography>
                        )}
                        {s.status !== 'scheduled' && (
                          <Chip 
                            label={s.status.replace('_', ' ')} 
                            size="small" 
                            color={s.status === 'accepted' ? 'success' : s.status === 'cancelled' ? 'error' : 'warning'}
                          />
                        )}
                      </Box>
                      <Typography variant="body2" color="text.secondary">
                        {formatArizonaTime(s.session_date)}
                        {s.location && ` — ${s.location}`}
                        {s.price && ` — $${s.price}`}
                      </Typography>
                      {s.coach_name ? (
                        <Chip label={`Coach: ${s.coach_name}`} size="small" variant="outlined" sx={{ mt: 0.5 }} />
                      ) : (
                        <Chip label="No coach assigned" size="small" color="warning" variant="outlined" sx={{ mt: 0.5 }} />
                      )}
                    </Box>
                  </Box>
                  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<EditIcon />}
                      onClick={() => openEditDialog(s, 'regular')}
                    >
                      Edit
                    </Button>
                    <Button 
                      size="small" 
                      variant="outlined" 
                      color="success" 
                      startIcon={<EventAvailableIcon />}
                      onClick={() => updateSessionStatus(s.id, 'accept')}
                    >
                      Accept
                    </Button>
                    <Button 
                      size="small" 
                      variant="outlined" 
                      color="warning" 
                      startIcon={<EventRepeatIcon />}
                      onClick={() => updateSessionStatus(s.id, 'reschedule')}
                    >
                      Reschedule
                    </Button>
                    <Button 
                      size="small" 
                      variant="outlined" 
                      color="error" 
                      startIcon={<CancelIcon />}
                      onClick={() => updateSessionStatus(s.id, 'cancel')}
                    >
                      Cancel
                    </Button>
                    <Button 
                      size="small" 
                      variant="outlined" 
                      color="error" 
                      startIcon={<EventBusyIcon />}
                      onClick={() => updateSessionStatus(s.id, 'no-show')}
                    >
                      No Show
                    </Button>
                  </Box>
                </Box>
                );
              })}
            </>
          )}
        </CardContent>
      </Card>

      {/* Pending Session Texts */}
      <Card variant="outlined" sx={{ mb: 3 }}>
        <CardContent>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
            <NotificationsIcon sx={{ color: data.pending_reminders.length > 0 ? 'error.main' : 'primary.main' }} />
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Session Texts ({data.pending_reminders.length}) — {selectedDayLabel}
            </Typography>
          </Box>
          {data.pending_reminders.length === 0 ? (
            <Typography color="text.secondary" variant="body2">No session texts due right now.</Typography>
          ) : (
            data.pending_reminders.map((reminder) => (
              <Box key={reminder.id} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', p: 1.5, bgcolor: 'grey.50', borderRadius: 1, mb: 1, gap: 2 }}>
                <Box sx={{ cursor: 'pointer', minWidth: 0 }} onClick={() => router.push(`/contacts/${reminder.parent_id}`)}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                    <Typography sx={{ fontWeight: 600 }}>
                      Text {reminder.parent_name}
                      {reminder.player_names && reminder.player_names.length > 0 && (
                        <Typography component="span" color="text.secondary">
                          {' '}
                          ({reminder.player_names.join(', ')})
                        </Typography>
                      )}
                    </Typography>
                    {(reminder.due_days_ago ?? 0) > 0 && (
                      <Chip
                        label={(reminder.due_days_ago ?? 0) === 1 ? 'Due yesterday' : `Due ${reminder.due_days_ago} days ago`}
                        size="small"
                        color={(reminder.due_days_ago ?? 0) > 1 ? 'error' : 'warning'}
                        sx={{ height: 20, '& .MuiChip-label': { px: 1, fontSize: '0.7rem' } }}
                      />
                    )}
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    {reminderTypeLabels[reminder.reminder_type] || reminder.reminder_type}
                  </Typography>
                </Box>
                <IconButton color="success" onClick={() => markReminderSent(reminder.id)} title="Mark as sent">
                  <CheckIcon />
                </IconButton>
              </Box>
            ))
          )}
        </CardContent>
      </Card>

      {/* Edit Session Dialog */}
      <Dialog open={!!editDialog} onClose={() => setEditDialog(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Edit Session</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
            <TextField
              label="Session Date/Time"
              type="datetime-local"
              fullWidth
              value={editForm.session_date}
              onChange={(e) => setEditForm({ ...editForm, session_date: e.target.value })}
              slotProps={{ inputLabel: { shrink: true } }}
            />
            <TextField
              label="Location"
              fullWidth
              value={editForm.location}
              onChange={(e) => setEditForm({ ...editForm, location: e.target.value })}
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
            {editDialog?.type === 'regular' && (
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
            )}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditDialog(null)}>Cancel</Button>
          <Button onClick={handleEdit} variant="contained">Save</Button>
        </DialogActions>
      </Dialog>
        </>
      )}
    </Box>
  );
}
