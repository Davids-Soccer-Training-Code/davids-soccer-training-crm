'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Chip from '@mui/material/Chip';
import Alert from '@mui/material/Alert';
import CircularProgress from '@mui/material/CircularProgress';
import Divider from '@mui/material/Divider';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import InputLabel from '@mui/material/InputLabel';
import FormControl from '@mui/material/FormControl';
import SendIcon from '@mui/icons-material/Send';
import VisibilityIcon from '@mui/icons-material/Visibility';
import EditIcon from '@mui/icons-material/Edit';
import EmailIcon from '@mui/icons-material/Email';

interface EmailContact {
  email: string;
  name: string;
  source: 'crm' | 'app' | 'signup';
  is_dead: boolean;
}

interface SendResult {
  sent_count: number;
  failed_count: number;
  sent: string[];
  failed: { email: string; error: string }[];
}

const SOURCE_LABEL: Record<string, string> = {
  crm: 'CRM',
  app: 'App',
  signup: 'Signup',
};
const SOURCE_COLOR: Record<string, 'primary' | 'secondary' | 'success' | 'default'> = {
  crm: 'primary',
  app: 'secondary',
  signup: 'success',
};

const DEFAULT_HTML = `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #1976d2;">Hi there!</h2>
  <p>Your message goes here.</p>
  <p>Best,<br/>Coach David</p>
</div>`;

export default function EmailBlastPage() {
  const [contacts, setContacts] = useState<EmailContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'crm' | 'app' | 'signup'>('all');
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(new Set());
  const [subject, setSubject] = useState('');
  const [html, setHtml] = useState(DEFAULT_HTML);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<SendResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDeadContacts, setShowDeadContacts] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    fetch('/api/email-blast', { cache: 'no-store' })
      .then((r) => r.json())
      .then((data: EmailContact[]) => setContacts(data))
      .catch(() => setError('Failed to load contacts'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (mode === 'preview' && iframeRef.current) {
      const doc = iframeRef.current.contentDocument;
      if (doc) {
        doc.open();
        doc.write(html);
        doc.close();
      }
    }
  }, [mode, html]);

  const sourceCounts = useMemo(() => {
    const counts: Record<string, number> = { crm: 0, app: 0, signup: 0 };
    contacts.forEach((c) => { counts[c.source] = (counts[c.source] ?? 0) + 1; });
    return counts;
  }, [contacts]);

  const filteredContacts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return contacts.filter((c) => {
      if (!showDeadContacts && c.is_dead) return false;
      if (sourceFilter !== 'all' && c.source !== sourceFilter) return false;
      if (!q) return true;
      return c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q);
    });
  }, [contacts, search, sourceFilter, showDeadContacts]);

  const allFilteredSelected = filteredContacts.length > 0 && filteredContacts.every((c) => selectedEmails.has(c.email));
  const someFilteredSelected = filteredContacts.some((c) => selectedEmails.has(c.email));

  const toggleContact = (email: string) => {
    setSelectedEmails((prev) => {
      const next = new Set(prev);
      if (next.has(email)) next.delete(email);
      else next.add(email);
      return next;
    });
  };

  const toggleAllFiltered = () => {
    setSelectedEmails((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        filteredContacts.forEach((c) => next.delete(c.email));
      } else {
        filteredContacts.forEach((c) => next.add(c.email));
      }
      return next;
    });
  };

  const handleSend = async () => {
    if (selectedEmails.size === 0) { setError('Select at least one contact.'); return; }
    if (!subject.trim()) { setError('Subject is required.'); return; }
    if (!html.trim()) { setError('Email body is required.'); return; }

    const confirmed = window.confirm(
      `Send this email to ${selectedEmails.size} contact${selectedEmails.size === 1 ? '' : 's'}?`
    );
    if (!confirmed) return;

    setSending(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch('/api/email-blast', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emails: Array.from(selectedEmails),
          subject: subject.trim(),
          html: html.trim(),
        }),
      });
      const data = await res.json() as SendResult & { error?: string };
      if (!res.ok) {
        setError(data.error || 'Failed to send emails');
      } else {
        setResult(data);
        if (data.sent_count > 0) setSelectedEmails(new Set());
      }
    } catch {
      setError('Failed to send emails');
    } finally {
      setSending(false);
    }
  };

  if (loading) return <Typography>Loading contacts...</Typography>;

  const selectedContactList = contacts.filter((c) => selectedEmails.has(c.email));

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '360px 1fr' }, gap: 3, alignItems: 'start' }}>
      {/* Left: Contact selector */}
      <Card variant="outlined">
        <CardContent>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5 }}>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              Contacts
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {contacts.length} total
            </Typography>
          </Box>

          {/* Source filter */}
          <FormControl size="small" fullWidth sx={{ mb: 1.5 }}>
            <InputLabel>Source</InputLabel>
            <Select
              value={sourceFilter}
              label="Source"
              onChange={(e) => setSourceFilter(e.target.value as typeof sourceFilter)}
            >
              <MenuItem value="all">All ({contacts.length})</MenuItem>
              <MenuItem value="crm">CRM Contacts ({sourceCounts.crm})</MenuItem>
              <MenuItem value="app">App Parents ({sourceCounts.app})</MenuItem>
              <MenuItem value="signup">Group Signups ({sourceCounts.signup})</MenuItem>
            </Select>
          </FormControl>

          <TextField
            size="small"
            placeholder="Search by name or email..."
            fullWidth
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            sx={{ mb: 1 }}
          />

          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={showDeadContacts}
                onChange={(e) => setShowDeadContacts(e.target.checked)}
              />
            }
            label={<Typography variant="body2">Show archived contacts</Typography>}
          />

          <Divider sx={{ my: 1 }} />

          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={allFilteredSelected}
                indeterminate={someFilteredSelected && !allFilteredSelected}
                onChange={toggleAllFiltered}
              />
            }
            label={
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                Select all ({filteredContacts.length})
              </Typography>
            }
          />

          <Box sx={{ maxHeight: 400, overflowY: 'auto', mt: 0.5 }}>
            {filteredContacts.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ py: 2, textAlign: 'center' }}>
                No contacts found
              </Typography>
            ) : (
              filteredContacts.map((contact) => (
                <FormControlLabel
                  key={contact.email}
                  sx={{ display: 'flex', mx: 0, py: 0.25, alignItems: 'flex-start' }}
                  control={
                    <Checkbox
                      size="small"
                      checked={selectedEmails.has(contact.email)}
                      onChange={() => toggleContact(contact.email)}
                      sx={{ pt: 0.5 }}
                    />
                  }
                  label={
                    <Box sx={{ pt: 0.25 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
                        <Typography variant="body2" sx={{ fontWeight: 500, lineHeight: 1.3 }}>
                          {contact.name}
                        </Typography>
                        <Chip
                          label={SOURCE_LABEL[contact.source] ?? contact.source}
                          size="small"
                          color={SOURCE_COLOR[contact.source] ?? 'default'}
                          sx={{ height: 16, fontSize: 10 }}
                        />
                        {contact.is_dead && (
                          <Chip label="archived" size="small" sx={{ height: 16, fontSize: 10 }} />
                        )}
                      </Box>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                        {contact.email}
                      </Typography>
                    </Box>
                  }
                />
              ))
            )}
          </Box>

          <Divider sx={{ mt: 1, mb: 1.5 }} />

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <EmailIcon fontSize="small" color="primary" />
            <Typography variant="body2">
              <strong>{selectedEmails.size}</strong> selected
              {selectedEmails.size > 0 && (
                <Button
                  size="small"
                  sx={{ ml: 1, minWidth: 0, p: 0, fontSize: 12 }}
                  onClick={() => setSelectedEmails(new Set())}
                >
                  Clear
                </Button>
              )}
            </Typography>
          </Box>
        </CardContent>
      </Card>

      {/* Right: Composer + preview */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {error && (
          <Alert severity="error" onClose={() => setError(null)}>{error}</Alert>
        )}

        {result && (
          <Alert
            severity={result.failed_count === 0 ? 'success' : 'warning'}
            onClose={() => setResult(null)}
          >
            <Typography variant="body2">
              Sent to <strong>{result.sent_count}</strong> contact{result.sent_count !== 1 ? 's' : ''}.
              {result.failed_count > 0 && (
                <> Failed for <strong>{result.failed_count}</strong>: {result.failed.map((f) => f.email).join(', ')}</>
              )}
            </Typography>
          </Alert>
        )}

        {selectedEmails.size > 0 && (
          <Box sx={{ display: 'flex', gap: 0.75, flexWrap: 'wrap' }}>
            {selectedContactList.slice(0, 10).map((c) => (
              <Chip
                key={c.email}
                label={c.name}
                size="small"
                onDelete={() => toggleContact(c.email)}
              />
            ))}
            {selectedContactList.length > 10 && (
              <Chip label={`+${selectedContactList.length - 10} more`} size="small" variant="outlined" />
            )}
          </Box>
        )}

        <Card variant="outlined">
          <CardContent sx={{ pb: '16px !important' }}>
            <Typography variant="h6" sx={{ fontWeight: 700, mb: 2 }}>
              Compose Email
            </Typography>

            <TextField
              label="Subject *"
              fullWidth
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              sx={{ mb: 2 }}
              placeholder="e.g. Upcoming Group Session This Weekend!"
            />

            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
              <Typography variant="body2" color="text.secondary">HTML Body</Typography>
              <ToggleButtonGroup
                value={mode}
                exclusive
                onChange={(_, v) => v && setMode(v)}
                size="small"
              >
                <ToggleButton value="edit">
                  <EditIcon fontSize="small" sx={{ mr: 0.5 }} />
                  Edit
                </ToggleButton>
                <ToggleButton value="preview">
                  <VisibilityIcon fontSize="small" sx={{ mr: 0.5 }} />
                  Preview
                </ToggleButton>
              </ToggleButtonGroup>
            </Box>

            {mode === 'edit' ? (
              <TextField
                multiline
                rows={16}
                fullWidth
                value={html}
                onChange={(e) => setHtml(e.target.value)}
                slotProps={{ input: { sx: { fontFamily: 'monospace', fontSize: 13 } } }}
                placeholder="Write or paste HTML here..."
              />
            ) : (
              <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, overflow: 'hidden', height: 400 }}>
                <iframe
                  ref={iframeRef}
                  title="Email Preview"
                  style={{ width: '100%', height: '100%', border: 'none' }}
                  sandbox="allow-same-origin"
                />
              </Box>
            )}

            <Box sx={{ mt: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
              <Typography variant="caption" color="text.secondary">
                Sending from: davidfalesct@gmail.com
              </Typography>
              <Button
                variant="contained"
                startIcon={sending ? <CircularProgress size={16} color="inherit" /> : <SendIcon />}
                onClick={handleSend}
                disabled={sending || selectedEmails.size === 0 || !subject.trim() || !html.trim()}
                size="large"
              >
                {sending ? 'Sending...' : `Send to ${selectedEmails.size} contact${selectedEmails.size !== 1 ? 's' : ''}`}
              </Button>
            </Box>
          </CardContent>
        </Card>
      </Box>
    </Box>
  );
}
