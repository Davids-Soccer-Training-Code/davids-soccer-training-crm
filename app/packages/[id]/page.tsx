'use client';

import { useState, useEffect, useCallback, use } from 'react';
import { useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Button from '@mui/material/Button';
import BadgeIcon from '@mui/icons-material/Badge';
import LinearProgress from '@mui/material/LinearProgress';
import TextField from '@mui/material/TextField';
import Divider from '@mui/material/Divider';
import MenuItem from '@mui/material/MenuItem';
import Alert from '@mui/material/Alert';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import { formatArizonaDateTime, toDatetimeLocal } from '@/lib/timezone';
import GooglePlacesTextField from '@/components/common/GooglePlacesTextField';

const packageTypeLabels: Record<string, string> = {
  '12_week_1x': '12 Weeks - 1x/week',
  '12_week_2x': '12 Weeks - 2x/week',
  '6_week_1x': '6 Weeks - 1x/week',
  '6_week_2x': '6 Weeks - 2x/week',
};

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

function getSessionsPerWeek(packageType: string): 1 | 2 {
  return packageType.endsWith('_2x') ? 2 : 1;
}

function parseScheduleSeed(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);

  const utcDate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  if (
    utcDate.getUTCFullYear() !== year ||
    utcDate.getUTCMonth() !== month - 1 ||
    utcDate.getUTCDate() !== day ||
    utcDate.getUTCHours() !== hour ||
    utcDate.getUTCMinutes() !== minute
  ) {
    return null;
  }

  return utcDate;
}

function formatScheduleSeed(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());
  const hour = pad(date.getUTCHours());
  const minute = pad(date.getUTCMinutes());
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

function addOneHour(datetimeLocal: string): string {
  const start = parseScheduleSeed(datetimeLocal);
  if (!start) return '';
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  return formatScheduleSeed(end);
}

interface PackageDetail {
  id: number;
  parent_id: number;
  parent_name: string;
  parent_email?: string | null;
  player_names: string[] | null;
  package_type: string;
  coach_id: number | null;
  coach_name: string | null;
  total_sessions: number;
  sessions_completed: number;
  price: number | string | null;
  amount_received: number | string | null;
  start_date: string | null;
  is_active: boolean;
  sessions: Array<{
    id: number;
    parent_id: number;
    title: string | null;
    session_date: string;
    session_end_date: string | null;
    status?: string | null;
    player_names: string[] | null;
    player_ids: number[] | null;
    location: string | null;
    guest_emails: string[] | null;
    send_email_updates: boolean | null;
    notes: string | null;
    showed_up: boolean | null;
    cancelled: boolean;
    was_paid: boolean;
    payment_method: string | null;
  }>;
  payment_events: Array<{
    id: number;
    package_id: number;
    amount: number | string;
    notes: string | null;
    created_at: string;
  }>;
}

interface PlayerOption {
  id: number;
  name: string;
}

interface ScheduleFormState {
  title: string;
  sessionDate: string;
  sessionEndDate: string;
  autoSlots: string[];
  location: string;
  guestEmails: string;
  sendEmailUpdates: boolean;
  notes: string;
  playerIds: number[];
}

interface EditFormState {
  title: string;
  sessionDate: string;
  sessionEndDate: string;
  location: string;
  guestEmails: string;
  sendEmailUpdates: boolean;
  notes: string;
  playerIds: number[];
}

export const dynamic = 'force-dynamic';

export default function PackageDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [pkg, setPkg] = useState<PackageDetail | null>(null);
  const [players, setPlayers] = useState<PlayerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingAmount, setSavingAmount] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [paymentDate, setPaymentDate] = useState(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(new Date())
  );
  const [scheduleDialogOpen, setScheduleDialogOpen] = useState(false);
  const [scheduleMode, setScheduleMode] = useState<'single' | 'auto'>('single');
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [scheduleForm, setScheduleForm] = useState<ScheduleFormState>({
    title: '',
    sessionDate: '',
    sessionEndDate: '',
    autoSlots: [''],
    location: '',
    guestEmails: '',
    sendEmailUpdates: false,
    notes: '',
    playerIds: [],
  });
  const [editingSession, setEditingSession] = useState<PackageDetail['sessions'][number] | null>(null);
  const [editForm, setEditForm] = useState<EditFormState>({
    title: '',
    sessionDate: '',
    sessionEndDate: '',
    location: '',
    guestEmails: '',
    sendEmailUpdates: false,
    notes: '',
    playerIds: [],
  });
  const [editSaving, setEditSaving] = useState(false);
  const [deleteSession, setDeleteSession] = useState<PackageDetail['sessions'][number] | null>(null);
  const [deleteSaving, setDeleteSaving] = useState(false);
  const [deletePackageOpen, setDeletePackageOpen] = useState(false);
  const [deletePackageSaving, setDeletePackageSaving] = useState(false);
  const [sessionStatusSavingId, setSessionStatusSavingId] = useState<number | null>(null);

  const fetchPackage = useCallback(async () => {
    const res = await fetch(`/api/packages/${id}`);
    if (res.ok) {
      const data: PackageDetail = await res.json();
      setPkg(data);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { fetchPackage(); }, [fetchPackage]);

  useEffect(() => {
    if (!pkg) return;

    let cancelled = false;
    fetch(`/api/parents/${pkg.parent_id}/players`)
      .then((res) => (res.ok ? res.json() : []))
      .then((data: PlayerOption[]) => {
        if (cancelled) return;
        setPlayers(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setPlayers([]);
      });

    return () => {
      cancelled = true;
    };
  }, [pkg]);

  const toggleActive = async () => {
    if (!pkg) return;
    await fetch(`/api/packages/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !pkg.is_active }),
    });
    fetchPackage();
  };

  const addPayment = async (amount: number, paidDate: string, notes: string) => {
    if (!pkg) return;
    if (!Number.isFinite(amount) || amount <= 0) return;

    setSavingAmount(true);
    const res = await fetch(`/api/packages/${id}/payments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount,
        paid_date: paidDate,
        notes,
      }),
    });

    if (res.ok) {
      await fetchPackage();
    }
    setSavingAmount(false);
  };

  const updatePlayerIds = (rawValue: unknown) => {
    const values = Array.isArray(rawValue)
      ? rawValue
      : typeof rawValue === 'string'
        ? rawValue.split(',')
        : rawValue == null
          ? []
          : [rawValue];

    const ids = values
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    return ids;
  };

  const createPackageSession = async (sessionDate: string, sessionEndDate?: string) => {
    if (!pkg) return false;

    const response = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parent_id: pkg.parent_id,
        package_id: pkg.id,
        player_ids: scheduleForm.playerIds,
        title: scheduleForm.title.trim() || null,
        session_date: sessionDate,
        session_end_date: sessionEndDate || addOneHour(sessionDate) || null,
        location: scheduleForm.location.trim() || null,
        guest_emails: scheduleForm.guestEmails
          .split(/[,\n;]+/)
          .map((email) => email.trim())
          .filter(Boolean),
        send_email_updates: scheduleForm.sendEmailUpdates,
        notes: scheduleForm.notes.trim() || null,
      }),
    });

    return response.ok;
  };

  const openScheduleDialog = (mode: 'single' | 'auto', sessionsPerWeek: number) => {
    const defaultPlayerIds = players.map((player) => player.id);
    setScheduleMode(mode);
    setScheduleError(null);
    setScheduleForm({
      title: '',
      sessionDate: '',
      sessionEndDate: '',
      autoSlots: Array.from({ length: sessionsPerWeek }, () => ''),
      location: '',
      guestEmails: pkg?.parent_email || '',
      sendEmailUpdates: false,
      notes: '',
      playerIds: defaultPlayerIds,
    });
    setScheduleDialogOpen(true);
  };

  const handleScheduleSave = async (remainingSessions: number) => {
    if (!pkg) return;
    if (remainingSessions <= 0) {
      setScheduleError('All sessions are already booked for this package.');
      return;
    }

    setScheduleSaving(true);
    setScheduleError(null);

    try {
      if (scheduleMode === 'single') {
        if (!scheduleForm.sessionDate) {
          setScheduleError('Pick a session date/time.');
          return;
        }
        const resolvedEnd = scheduleForm.sessionEndDate || addOneHour(scheduleForm.sessionDate);
        if (!resolvedEnd || resolvedEnd <= scheduleForm.sessionDate) {
          setScheduleError('Session end time must be after session start time.');
          return;
        }
        const success = await createPackageSession(scheduleForm.sessionDate, resolvedEnd);
        if (!success) {
          setScheduleError('Could not schedule session.');
          return;
        }
      } else {
        const expectedSlots = getSessionsPerWeek(pkg.package_type);
        const slotInputs = scheduleForm.autoSlots.filter((value) => value.trim().length > 0);
        if (slotInputs.length < expectedSlots) {
          setScheduleError(`Pick ${expectedSlots} weekly slot${expectedSlots === 1 ? '' : 's'}.`);
          return;
        }
        if (new Set(slotInputs).size !== slotInputs.length) {
          setScheduleError('Weekly slots must be different.');
          return;
        }

        const seeds = slotInputs.map((value) => parseScheduleSeed(value));
        if (seeds.some((seed) => !seed)) {
          setScheduleError('One or more slot date/times are invalid.');
          return;
        }

        const queue = seeds
          .filter((seed): seed is Date => seed !== null)
          .map((seed) => ({ next: seed }));

        const activeSessions = pkg.sessions.filter((session) => {
          const status = session.status?.toLowerCase();
          return !session.cancelled && status !== 'cancelled' && status !== 'no_show';
        });
        const existingDateTimes = new Set(activeSessions.map((session) => toDatetimeLocal(session.session_date)));
        const newDateTimes: string[] = [];
        const newDateTimesSet = new Set<string>();
        let guard = 0;

        while (newDateTimes.length < remainingSessions && guard < 1500) {
          queue.sort((a, b) => a.next.getTime() - b.next.getTime());
          const earliest = queue[0];
          const candidate = formatScheduleSeed(earliest.next);

          if (!existingDateTimes.has(candidate) && !newDateTimesSet.has(candidate)) {
            newDateTimes.push(candidate);
            newDateTimesSet.add(candidate);
          }

          earliest.next = new Date(earliest.next.getTime() + MS_PER_WEEK);
          guard += 1;
        }

        if (newDateTimes.length < remainingSessions) {
          setScheduleError('Could not generate enough future slots. Try later start dates.');
          return;
        }

        for (const sessionDate of newDateTimes) {
          // Keep order deterministic and avoid overloading APIs/reminder inserts.
          const success = await createPackageSession(sessionDate, addOneHour(sessionDate));
          if (!success) {
            setScheduleError('Some sessions could not be scheduled. Please try again.');
            return;
          }
        }
      }

      setScheduleDialogOpen(false);
      await fetchPackage();
    } finally {
      setScheduleSaving(false);
    }
  };

  const openEditDialog = (session: PackageDetail['sessions'][number]) => {
    setEditingSession(session);
    setEditForm({
      title: session.title || '',
      sessionDate: toDatetimeLocal(session.session_date),
      sessionEndDate: session.session_end_date ? toDatetimeLocal(session.session_end_date) : '',
      location: session.location || '',
      guestEmails:
        (session.guest_emails && session.guest_emails.length > 0)
          ? session.guest_emails.join(', ')
          : (pkg?.parent_email || ''),
      sendEmailUpdates: session.send_email_updates === true,
      notes: session.notes || '',
      playerIds: session.player_ids || [],
    });
  };

  const handleSaveEdit = async () => {
    if (!editingSession) return;
    if (!editForm.sessionDate) return;

    setEditSaving(true);
    try {
      const sessionResponse = await fetch(`/api/sessions/${editingSession.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editForm.title.trim() || null,
          session_date: editForm.sessionDate,
          session_end_date: editForm.sessionEndDate || null,
          location: editForm.location.trim() || null,
          guest_emails: editForm.guestEmails
            .split(/[,\n;]+/)
            .map((email) => email.trim())
            .filter(Boolean),
          send_email_updates: editForm.sendEmailUpdates,
          notes: editForm.notes.trim() || null,
        }),
      });

      if (!sessionResponse.ok) return;

      const playersResponse = await fetch(`/api/sessions/${editingSession.id}/players`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ player_ids: editForm.playerIds }),
      });

      if (!playersResponse.ok) return;

      setEditingSession(null);
      await fetchPackage();
    } finally {
      setEditSaving(false);
    }
  };

  const handleDeleteSession = async () => {
    if (!deleteSession) return;
    setDeleteSaving(true);
    try {
      const response = await fetch(`/api/sessions/${deleteSession.id}`, {
        method: 'DELETE',
      });
      if (!response.ok) return;
      setDeleteSession(null);
      await fetchPackage();
    } finally {
      setDeleteSaving(false);
    }
  };

  const handleDeletePackage = async () => {
    setDeletePackageSaving(true);
    try {
      const response = await fetch(`/api/packages/${id}`, {
        method: 'DELETE',
      });
      if (!response.ok) return;
      router.push('/packages');
    } finally {
      setDeletePackageSaving(false);
    }
  };

  const isSessionClosed = (session: PackageDetail['sessions'][number]) => {
    const status = session.status?.toLowerCase();
    return (
      session.cancelled ||
      status === 'cancelled' ||
      status === 'completed' ||
      status === 'no_show' ||
      session.showed_up !== null
    );
  };

  const isPendingCompletion = (session: PackageDetail['sessions'][number]) => {
    const sessionTime = new Date(session.session_date).getTime();
    return Number.isFinite(sessionTime) && sessionTime <= Date.now() && !isSessionClosed(session);
  };

  const handlePackageSessionStatusAction = async (
    session: PackageDetail['sessions'][number],
    action: 'complete' | 'cancel'
  ) => {
    setSessionStatusSavingId(session.id);
    try {
      if (action === 'complete') {
        const completeResponse = await fetch(`/api/sessions/${session.id}/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            showed_up: true,
            cancelled: false,
            was_paid: session.was_paid ?? false,
            payment_method: session.payment_method ?? null,
          }),
        });
        if (!completeResponse.ok) return;
      } else {
        const cancelResponse = await fetch(`/api/sessions/${session.id}/cancel`, {
          method: 'POST',
        });
        if (!cancelResponse.ok) return;
      }

      await fetchPackage();
    } finally {
      setSessionStatusSavingId(null);
    }
  };

  if (loading) return <Typography>Loading...</Typography>;
  if (!pkg) return <Typography>Package not found.</Typography>;

  const progress = pkg.total_sessions > 0 ? (pkg.sessions_completed / pkg.total_sessions) * 100 : 0;
  const packagePrice = Number(pkg.price ?? 0);
  const currentReceived = Number(pkg.amount_received ?? 0);
  const hasPrice = packagePrice > 0;
  const percentReceived = hasPrice ? Math.min((currentReceived / packagePrice) * 100, 100) : 0;
  const displayReceived = hasPrice ? Math.min(currentReceived, packagePrice) : currentReceived;
  const sessionsPerWeek = getSessionsPerWeek(pkg.package_type);
  const bookedSessions = pkg.sessions.filter((session) => {
    const status = session.status?.toLowerCase();
    return !session.cancelled && status !== 'cancelled' && status !== 'no_show';
  });
  const remainingSessions = Math.max(pkg.total_sessions - bookedSessions.length, 0);

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', mb: 3 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            {pkg.parent_name}
            {pkg.player_names && pkg.player_names.length > 0 && (
              <Typography component="span" variant="h4" sx={{ fontWeight: 400, color: 'text.secondary', ml: 1 }}>
                ({pkg.player_names.join(', ')})
              </Typography>
            )}
          </Typography>
          <Typography color="text.secondary">
            {packageTypeLabels[pkg.package_type] || pkg.package_type}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
          <Chip
            icon={<BadgeIcon />}
            label={pkg.coach_name ? `Coach: ${pkg.coach_name}` : 'No coach assigned'}
            color={pkg.coach_name ? 'primary' : 'warning'}
            variant={pkg.coach_name ? 'filled' : 'outlined'}
          />
          <Chip label={pkg.is_active ? 'Active' : 'Completed'} color={pkg.is_active ? 'success' : 'default'} />
          <Button size="small" variant="outlined" onClick={toggleActive}>
            {pkg.is_active ? 'Mark Complete' : 'Reactivate'}
          </Button>
          <Button size="small" variant="outlined" color="error" onClick={() => setDeletePackageOpen(true)}>
            Delete Package
          </Button>
        </Box>
      </Box>

      {/* Progress */}
      <Card sx={{ mb: 3 }}>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 1.25 }}>Progress</Typography>
          <Box sx={{ display: 'grid', gap: 1.25 }}>
            <Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                <Typography variant="body2" color="text.secondary">Sessions</Typography>
                <Typography variant="body2" sx={{ fontWeight: 700 }}>
                  {pkg.sessions_completed} / {pkg.total_sessions}
                </Typography>
              </Box>
              <LinearProgress variant="determinate" value={progress} sx={{ height: 12, borderRadius: 6 }} />
            </Box>

            <Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                <Typography variant="body2" color="text.secondary">Payment</Typography>
                <Typography variant="body2" sx={{ fontWeight: 700 }}>
                  {hasPrice
                    ? `${currency.format(displayReceived)} / ${currency.format(packagePrice)} (${percentReceived.toFixed(0)}%)`
                    : `${currency.format(displayReceived)} received`}
                </Typography>
              </Box>
              <LinearProgress
                variant="determinate"
                value={percentReceived}
                color="success"
                sx={{ height: 12, borderRadius: 6 }}
              />
            </Box>
          </Box>
          {hasPrice && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Package price: {currency.format(packagePrice)}
            </Typography>
          )}
          {!hasPrice && (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              Set package price to enable payment percent tracking.
            </Typography>
          )}

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '180px 1fr auto' }, gap: 1, mt: 1.5, alignItems: 'center' }}>
            <TextField
              size="small"
              label="Payment Date"
              type="date"
              value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)}
              slotProps={{ inputLabel: { shrink: true } }}
              fullWidth
            />
            <TextField
              size="small"
              label="Add Amount ($)"
              type="number"
              value={paymentAmount}
              onChange={(e) => setPaymentAmount(e.target.value)}
              fullWidth
            />
            <Button
              variant="contained"
              disabled={savingAmount || !paymentAmount || !hasPrice}
              onClick={async () => {
                const amount = Number(paymentAmount);
                if (!Number.isFinite(amount) || amount <= 0) return;
                const remaining = Number((packagePrice - currentReceived).toFixed(2));
                const safeAmount = Math.min(amount, Math.max(0, remaining));
                if (safeAmount <= 0) return;
                await addPayment(safeAmount, paymentDate, 'manual_payment');
                setPaymentAmount('');
              }}
            >
              Add Payment
            </Button>
          </Box>

          {!hasPrice && (
            <Typography variant="caption" color="text.secondary">
              Add package price to track money received.
            </Typography>
          )}
          {pkg.start_date && (
            <Typography variant="body2" color="text.secondary">
              Started: {new Date(pkg.start_date).toLocaleDateString()}
            </Typography>
          )}
          {pkg.payment_events.length > 0 && (
            <>
              <Divider sx={{ my: 1.5 }} />
              <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>
                Payment History
              </Typography>
              <Box sx={{ display: 'grid', gap: 0.75, maxHeight: 180, overflowY: 'auto' }}>
                {pkg.payment_events.map((evt) => (
                  <Box key={evt.id} sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
                    <Typography variant="caption" color="text.secondary">
                      {new Date(evt.created_at).toLocaleDateString()} {evt.notes ? `• ${evt.notes}` : ''}
                    </Typography>
                    <Typography variant="caption" sx={{ fontWeight: 700 }}>
                      ${Number(evt.amount).toFixed(2)}
                    </Typography>
                  </Box>
                ))}
              </Box>
            </>
          )}
        </CardContent>
      </Card>

      {/* Sessions in this package */}
      <Card>
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Sessions ({pkg.sessions.length})
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              <Typography variant="caption" color="text.secondary">
                Remaining to book: {remainingSessions}
              </Typography>
              <Button
                size="small"
                variant="outlined"
                disabled={remainingSessions <= 0}
                onClick={() => openScheduleDialog('auto', sessionsPerWeek)}
              >
                Auto-Schedule Remaining
              </Button>
              <Button
                size="small"
                variant="contained"
                disabled={remainingSessions <= 0}
                onClick={() => openScheduleDialog('single', sessionsPerWeek)}
              >
                Schedule Session
              </Button>
            </Box>
          </Box>
          {pkg.sessions.length === 0 ? (
            <Typography color="text.secondary" variant="body2">No sessions booked for this package yet.</Typography>
          ) : (
            pkg.sessions.map((s) => {
              const pendingCompletion = isPendingCompletion(s);
              const statusActionSaving = sessionStatusSavingId === s.id;

              return (
                <Box
                  key={s.id}
                  sx={{ p: 1.5, bgcolor: 'grey.50', borderRadius: 2, mb: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2 }}
                >
                  <Box>
                    <Typography sx={{ fontWeight: 600 }}>
                      {formatArizonaDateTime(s.session_date)}
                    </Typography>
                    {s.location && (
                      <Typography variant="body2" color="text.secondary">
                        {s.location}
                      </Typography>
                    )}
                    {s.player_names && s.player_names.length > 0 && (
                      <Typography variant="body2" color="text.secondary">
                        {s.player_names.join(', ')}
                      </Typography>
                    )}
                  </Box>
                  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    {(() => {
                      const status = s.status?.toLowerCase();
                      const sessionTime = new Date(s.session_date).getTime();
                      const isUpcoming = Number.isFinite(sessionTime) ? sessionTime > Date.now() : false;

                      if (status && status !== 'scheduled') {
                        return (
                          <Chip
                            label={status.replace('_', ' ')}
                            color={
                              status === 'accepted' || status === 'completed'
                                ? 'success'
                                : status === 'cancelled' || status === 'no_show'
                                  ? 'error'
                                  : status === 'rescheduled'
                                    ? 'warning'
                                    : 'info'
                            }
                            size="small"
                          />
                        );
                      }

                      if (s.showed_up === true) return <Chip label="Showed Up" color="success" size="small" />;
                      if (s.cancelled) return <Chip label="Cancelled" color="error" size="small" />;
                      if (isUpcoming) return <Chip label="Upcoming" color="info" size="small" />;
                      return <Chip label="Pending Completion" color="warning" size="small" />;
                    })()}
                    {s.was_paid && <Chip label={`Paid (${s.payment_method})`} size="small" variant="outlined" />}
                    {pendingCompletion && (
                      <>
                        <Button
                          size="small"
                          variant="contained"
                          color="success"
                          disabled={statusActionSaving}
                          onClick={() => handlePackageSessionStatusAction(s, 'complete')}
                        >
                          Complete
                        </Button>
                        <Button
                          size="small"
                          variant="outlined"
                          color="error"
                          disabled={statusActionSaving}
                          onClick={() => handlePackageSessionStatusAction(s, 'cancel')}
                        >
                          Cancel
                        </Button>
                      </>
                    )}
                    <Button size="small" variant="outlined" onClick={() => openEditDialog(s)}>
                      Edit
                    </Button>
                    <Button size="small" variant="outlined" color="error" onClick={() => setDeleteSession(s)}>
                      Delete
                    </Button>
                  </Box>
                </Box>
              );
            })
          )}
        </CardContent>
      </Card>

      <Dialog open={scheduleDialogOpen} onClose={() => setScheduleDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>
          {scheduleMode === 'auto' ? 'Auto-Schedule Remaining Sessions' : 'Schedule Session'}
        </DialogTitle>
        <DialogContent>
          <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Typography variant="body2" color="text.secondary">
              {remainingSessions} session{remainingSessions === 1 ? '' : 's'} left to book.
            </Typography>
            {scheduleMode === 'auto' && (
              <Typography variant="body2" color="text.secondary">
                This package is {sessionsPerWeek}x/week. Pick {sessionsPerWeek} weekly slot{sessionsPerWeek === 1 ? '' : 's'} and it will fill all remaining sessions automatically.
              </Typography>
            )}

            {scheduleMode === 'single' ? (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <TextField
                  label="Session Date & Time"
                  type="datetime-local"
                  value={scheduleForm.sessionDate}
                  onChange={(event) =>
                    setScheduleForm((prev) => {
                      const nextStart = event.target.value;
                      return {
                        ...prev,
                        sessionDate: nextStart,
                        sessionEndDate:
                          !prev.sessionEndDate || prev.sessionEndDate <= nextStart
                            ? addOneHour(nextStart)
                            : prev.sessionEndDate,
                      };
                    })
                  }
                  slotProps={{ inputLabel: { shrink: true } }}
                  fullWidth
                  required
                />
                <TextField
                  label="Session End Time"
                  type="datetime-local"
                  value={scheduleForm.sessionEndDate}
                  onChange={(event) =>
                    setScheduleForm((prev) => ({ ...prev, sessionEndDate: event.target.value }))
                  }
                  slotProps={{ inputLabel: { shrink: true } }}
                  fullWidth
                  required
                />
              </Box>
            ) : (
              scheduleForm.autoSlots.map((slot, index) => (
                <TextField
                  key={`auto-slot-${index}`}
                  label={`Weekly Slot ${index + 1} (Date & Time)`}
                  type="datetime-local"
                  value={slot}
                  onChange={(event) => {
                    const nextSlots = [...scheduleForm.autoSlots];
                    nextSlots[index] = event.target.value;
                    setScheduleForm((prev) => ({ ...prev, autoSlots: nextSlots }));
                  }}
                  slotProps={{ inputLabel: { shrink: true } }}
                  fullWidth
                  required
                />
              ))
            )}

            <TextField
              label="Session Title"
              value={scheduleForm.title}
              onChange={(event) => setScheduleForm((prev) => ({ ...prev, title: event.target.value }))}
              fullWidth
            />

            <GooglePlacesTextField
              label="Location"
              value={scheduleForm.location}
              onValueChange={(value) => setScheduleForm((prev) => ({ ...prev, location: value }))}
              fullWidth
            />

            <TextField
              label="Guest Emails (comma separated)"
              value={scheduleForm.guestEmails}
              onChange={(event) => setScheduleForm((prev) => ({ ...prev, guestEmails: event.target.value }))}
              fullWidth
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={scheduleForm.sendEmailUpdates}
                  onChange={(event) =>
                    setScheduleForm((prev) => ({ ...prev, sendEmailUpdates: event.target.checked }))
                  }
                />
              }
              label="Send Google email updates to guests"
            />

            {players.length > 0 && (
              <TextField
                label="Players (select multiple)"
                select
                fullWidth
                SelectProps={{ multiple: true, value: scheduleForm.playerIds }}
                onChange={(event) =>
                  setScheduleForm((prev) => ({ ...prev, playerIds: updatePlayerIds(event.target.value) }))
                }
              >
                {players.map((player) => (
                  <MenuItem key={player.id} value={player.id}>
                    {player.name}
                  </MenuItem>
                ))}
              </TextField>
            )}

            <TextField
              label="Notes"
              value={scheduleForm.notes}
              onChange={(event) => setScheduleForm((prev) => ({ ...prev, notes: event.target.value }))}
              multiline
              minRows={2}
              fullWidth
            />

            {scheduleError && <Alert severity="error">{scheduleError}</Alert>}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setScheduleDialogOpen(false)} disabled={scheduleSaving}>
            Cancel
          </Button>
          <Button
            onClick={() => handleScheduleSave(remainingSessions)}
            variant="contained"
            disabled={scheduleSaving || remainingSessions <= 0}
          >
            {scheduleSaving
              ? 'Scheduling...'
              : scheduleMode === 'auto'
                ? `Schedule ${remainingSessions} Sessions`
                : 'Schedule Session'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!editingSession} onClose={() => setEditingSession(null)} maxWidth="sm" fullWidth>
        <DialogTitle>Edit Session</DialogTitle>
        <DialogContent>
          <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <TextField
              label="Session Title"
              value={editForm.title}
              onChange={(event) => setEditForm((prev) => ({ ...prev, title: event.target.value }))}
              fullWidth
            />
            <TextField
              label="Session Date & Time"
              type="datetime-local"
              value={editForm.sessionDate}
              onChange={(event) => setEditForm((prev) => ({ ...prev, sessionDate: event.target.value }))}
              slotProps={{ inputLabel: { shrink: true } }}
              fullWidth
              required
            />
            <TextField
              label="Session End Time"
              type="datetime-local"
              value={editForm.sessionEndDate}
              onChange={(event) => setEditForm((prev) => ({ ...prev, sessionEndDate: event.target.value }))}
              slotProps={{ inputLabel: { shrink: true } }}
              fullWidth
            />
            <GooglePlacesTextField
              label="Location"
              value={editForm.location}
              onValueChange={(value) => setEditForm((prev) => ({ ...prev, location: value }))}
              fullWidth
            />
            <TextField
              label="Guest Emails (comma separated)"
              value={editForm.guestEmails}
              onChange={(event) => setEditForm((prev) => ({ ...prev, guestEmails: event.target.value }))}
              fullWidth
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={editForm.sendEmailUpdates}
                  onChange={(event) =>
                    setEditForm((prev) => ({ ...prev, sendEmailUpdates: event.target.checked }))
                  }
                />
              }
              label="Send Google email updates to guests"
            />
            {players.length > 0 && (
              <TextField
                label="Players (select multiple)"
                select
                fullWidth
                SelectProps={{ multiple: true, value: editForm.playerIds }}
                onChange={(event) =>
                  setEditForm((prev) => ({ ...prev, playerIds: updatePlayerIds(event.target.value) }))
                }
              >
                {players.map((player) => (
                  <MenuItem key={player.id} value={player.id}>
                    {player.name}
                  </MenuItem>
                ))}
              </TextField>
            )}
            <TextField
              label="Notes"
              value={editForm.notes}
              onChange={(event) => setEditForm((prev) => ({ ...prev, notes: event.target.value }))}
              multiline
              minRows={2}
              fullWidth
            />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setEditingSession(null)} disabled={editSaving}>
            Cancel
          </Button>
          <Button onClick={handleSaveEdit} variant="contained" disabled={editSaving || !editForm.sessionDate}>
            {editSaving ? 'Saving...' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!deleteSession} onClose={() => setDeleteSession(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete Session?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            This removes the session scheduled for{' '}
            {deleteSession ? formatArizonaDateTime(deleteSession.session_date) : ''}.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteSession(null)} disabled={deleteSaving}>
            Cancel
          </Button>
          <Button color="error" variant="contained" onClick={handleDeleteSession} disabled={deleteSaving}>
            {deleteSaving ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={deletePackageOpen} onClose={() => setDeletePackageOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete Package?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            Deleting this package keeps session history but removes package linkage.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeletePackageOpen(false)} disabled={deletePackageSaving}>
            Cancel
          </Button>
          <Button color="error" variant="contained" onClick={handleDeletePackage} disabled={deletePackageSaving}>
            {deletePackageSaving ? 'Deleting...' : 'Delete Package'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
