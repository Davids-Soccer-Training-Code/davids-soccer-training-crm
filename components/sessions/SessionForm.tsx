'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import FormControlLabel from '@mui/material/FormControlLabel';
import Checkbox from '@mui/material/Checkbox';
import type { Parent, Player } from '@/lib/types';
import GooglePlacesTextField from '@/components/common/GooglePlacesTextField';

function addOneHour(datetimeLocal: string): string {
  const start = new Date(datetimeLocal);
  if (Number.isNaN(start.getTime())) return '';

  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}T${pad(end.getHours())}:${pad(end.getMinutes())}`;
}

export default function SessionForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const preselectedParentId = searchParams.get('parent_id');
  const preselectedPackageId = searchParams.get('package_id');

  const [saving, setSaving] = useState(false);
  const [parents, setParents] = useState<Parent[]>([]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [parentId, setParentId] = useState(preselectedParentId || '');
  const [packageId] = useState(preselectedPackageId || '');
  const [playerIds, setPlayerIds] = useState<string[]>([]);
  const [sessionDate, setSessionDate] = useState('');
  const [sessionEndDate, setSessionEndDate] = useState('');
  const [sessionTitle, setSessionTitle] = useState('');
  const [location, setLocation] = useState('');
  const [guestEmails, setGuestEmails] = useState('');
  const [sendEmailUpdates, setSendEmailUpdates] = useState(false);
  const parentDefaultGuestEmailRef = useRef('');
  const [price, setPrice] = useState('');
  const [notes, setNotes] = useState('');
  const [isFirstSession, setIsFirstSession] = useState(false);
  const [depositPaid, setDepositPaid] = useState(false);
  const [depositAmount, setDepositAmount] = useState('');
  const [staff, setStaff] = useState<{ id: number; name: string }[]>([]);
  const [coachId, setCoachId] = useState('');
  const coachTouchedRef = useRef(false);

  useEffect(() => {
    fetch('/api/parents').then((r) => r.json()).then(setParents);
  }, []);

  useEffect(() => {
    fetch('/api/staff').then((r) => r.json()).then((rows) =>
      setStaff(rows.map((s: { id: number; name: string }) => ({ id: s.id, name: s.name })))
    );
  }, []);

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

  // Autofill coach from the first selected player that has one (unless user overrode it)
  useEffect(() => {
    if (coachTouchedRef.current) return;
    const selectedIds = playerIds.map(String);
    const selected = players.filter((pl) => selectedIds.includes(String(pl.id)));
    const withCoach = selected.find(
      (pl) => (pl as Player & { coach_id?: number | null }).coach_id != null
    ) as (Player & { coach_id?: number | null }) | undefined;
    setCoachId(withCoach?.coach_id != null ? String(withCoach.coach_id) : '');
  }, [players, playerIds]);

  // Auto-detect if this should be a first session
  useEffect(() => {
    if (parentId) {
      fetch(`/api/parents/${parentId}`).then((r) => r.json()).then((data) => {
        const hasFirstSession = data.first_session;
        setIsFirstSession(!hasFirstSession);

        const parentEmail =
          typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
        setGuestEmails((previous) => {
          if (!previous || previous === parentDefaultGuestEmailRef.current) {
            return parentEmail;
          }
          return previous;
        });
        parentDefaultGuestEmailRef.current = parentEmail;
      });
    } else {
      setGuestEmails((previous) =>
        previous === parentDefaultGuestEmailRef.current ? '' : previous
      );
      parentDefaultGuestEmailRef.current = '';
    }
  }, [parentId]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!parentId || !sessionDate) return;

    setSaving(true);
    try {
      const endpoint = isFirstSession ? '/api/first-sessions' : '/api/sessions';
      const resolvedEndDate = !isFirstSession
        ? (sessionEndDate || addOneHour(sessionDate))
        : '';
      const payload: Record<string, unknown> = {
        parent_id: parseInt(parentId),
        player_ids: playerIds.map(id => parseInt(id)),
        session_date: sessionDate,
        location: location || null,
        price: packageId ? null : (price ? parseFloat(price) : null), // No price for package sessions
        notes: notes || null,
        coach_id: coachId ? parseInt(coachId) : null,
        guest_emails: guestEmails
          .split(/[,\n;]+/)
          .map((email) => email.trim())
          .filter(Boolean),
        send_email_updates: sendEmailUpdates,
      };

      if (isFirstSession) {
        payload.deposit_paid = depositPaid;
        payload.deposit_amount = depositAmount ? parseFloat(depositAmount) : null;
        payload.title = sessionTitle.trim() || null;
        payload.session_end_date = sessionEndDate || addOneHour(sessionDate) || null;
      } else {
        payload.session_end_date = resolvedEndDate;
        payload.title = sessionTitle.trim() || null;
        if (packageId) {
          payload.package_id = parseInt(packageId);
        }
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        router.push('/sessions');
      }
    } catch (error) {
      console.error('Error creating session:', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <Card sx={{ mb: 3 }}>
        <CardContent>
          {isFirstSession && (
            <Box sx={{ mb: 2, p: 2, bgcolor: 'primary.main', color: 'white', borderRadius: 2 }}>
              <Typography sx={{ fontWeight: 600 }}>First Session (Trial)</Typography>
              <Typography variant="body2">This parent hasn&apos;t had a session yet. This will be their first/trial session.</Typography>
            </Box>
          )}
          {packageId && !isFirstSession && (
            <Box sx={{ mb: 2, p: 2, bgcolor: 'success.main', color: 'white', borderRadius: 2 }}>
              <Typography sx={{ fontWeight: 600 }}>Package Session</Typography>
              <Typography variant="body2">This session will be linked to the selected package deal.</Typography>
            </Box>
          )}

          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 2 }}>
            <TextField
              label="Parent *"
              value={parentId}
              onChange={(e) => { setParentId(e.target.value); setPlayerIds([]); }}
              select
              fullWidth
              required
            >
              {parents.map((p: Parent & { player_names?: string[] }) => (
                <MenuItem key={p.id} value={p.id}>
                  {p.name}
                  {p.player_names && p.player_names.length > 0 && ` (${p.player_names.join(', ')})`}
                </MenuItem>
              ))}
            </TextField>

            <TextField
              label="Players (select multiple)"
              value={playerIds}
              onChange={(e) => setPlayerIds(typeof e.target.value === 'string' ? [e.target.value] : e.target.value as string[])}
              select
              fullWidth
              disabled={!parentId || players.length === 0}
              SelectProps={{ multiple: true }}
            >
              {players.map((pl: Player) => (
                <MenuItem key={pl.id} value={pl.id}>{pl.name}</MenuItem>
              ))}
            </TextField>

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

            <TextField
              label="Session Date & Time *"
              type="datetime-local"
              value={sessionDate}
              onChange={(e) => {
                const nextStart = e.target.value;
                setSessionDate(nextStart);
                if (!isFirstSession && (!sessionEndDate || sessionEndDate <= nextStart)) {
                  setSessionEndDate(addOneHour(nextStart));
                }
              }}
              fullWidth
              required
              slotProps={{ inputLabel: { shrink: true } }}
            />

            <TextField
              label="Session End Time *"
              type="datetime-local"
              value={sessionEndDate}
              onChange={(e) => setSessionEndDate(e.target.value)}
              fullWidth
              required
              slotProps={{ inputLabel: { shrink: true } }}
            />

            <TextField
              label="Session Title"
              value={sessionTitle}
              onChange={(e) => setSessionTitle(e.target.value)}
              fullWidth
              placeholder="Example: Rylen + Mia Weekly Training"
            />

            <GooglePlacesTextField
              label="Location"
              value={location}
              onValueChange={setLocation}
              fullWidth
            />
            {!packageId && (
              <TextField label="Price ($)" value={price} onChange={(e) => setPrice(e.target.value)} type="number" fullWidth />
            )}
          </Box>

          <Box sx={{ mt: 2 }}>
            <TextField
              label="Guest Emails (comma separated)"
              value={guestEmails}
              onChange={(e) => setGuestEmails(e.target.value)}
              fullWidth
              placeholder="parent1@email.com, parent2@email.com"
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={sendEmailUpdates}
                  onChange={(e) => setSendEmailUpdates(e.target.checked)}
                />
              }
              label="Send Google email updates to guests"
              sx={{ mt: 1 }}
            />
          </Box>

          {isFirstSession && (
            <Box sx={{ mt: 2, p: 2, bgcolor: 'grey.50', borderRadius: 2 }}>
              <Typography variant="subtitle2" sx={{ mb: 1 }}>Deposit</Typography>
              <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                <FormControlLabel
                  control={<Checkbox checked={depositPaid} onChange={(e) => setDepositPaid(e.target.checked)} />}
                  label="Deposit Paid"
                />
                {depositPaid && (
                  <TextField
                    label="Deposit Amount ($)"
                    value={depositAmount}
                    onChange={(e) => setDepositAmount(e.target.value)}
                    type="number"
                    size="small"
                  />
                )}
              </Box>
            </Box>
          )}

          <TextField label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} multiline rows={2} fullWidth sx={{ mt: 2 }} />
        </CardContent>
      </Card>

      <Box sx={{ display: 'flex', gap: 2 }}>
        <Button
          variant="contained"
          type="submit"
          disabled={saving || !parentId || !sessionDate || (!isFirstSession && !sessionEndDate)}
          size="large"
        >
          {saving ? 'Saving...' : isFirstSession ? 'Book First Session' : 'Book Session'}
        </Button>
        <Button variant="outlined" onClick={() => router.back()} size="large">Cancel</Button>
      </Box>
    </form>
  );
}
