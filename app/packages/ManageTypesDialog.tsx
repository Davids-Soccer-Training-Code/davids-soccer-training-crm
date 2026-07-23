'use client';

import { useState } from 'react';
import Box from '@mui/material/Box';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Switch from '@mui/material/Switch';
import IconButton from '@mui/material/IconButton';
import Divider from '@mui/material/Divider';
import Tooltip from '@mui/material/Tooltip';
import Alert from '@mui/material/Alert';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import CheckIcon from '@mui/icons-material/Check';
import CloseIcon from '@mui/icons-material/Close';
import type { PackageTypeDef } from '@/lib/types';

interface Props {
  open: boolean;
  onClose: () => void;
  types: PackageTypeDef[];
  onChanged: () => void | Promise<void>;
}

interface EditState {
  label: string;
  total_sessions: string;
  sessions_per_week: string;
}

export default function ManageTypesDialog({ open, onClose, types, onChanged }: Props) {
  const [newLabel, setNewLabel] = useState('');
  const [newTotal, setNewTotal] = useState('');
  const [newPerWeek, setNewPerWeek] = useState('1');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editState, setEditState] = useState<EditState>({ label: '', total_sessions: '', sessions_per_week: '' });

  const resetNew = () => { setNewLabel(''); setNewTotal(''); setNewPerWeek('1'); };

  const handleAdd = async () => {
    setError(null);
    const total = parseInt(newTotal, 10);
    const perWeek = parseInt(newPerWeek, 10);
    if (!newLabel.trim()) { setError('Name is required.'); return; }
    if (!Number.isInteger(total) || total < 1) { setError('Total sessions must be at least 1.'); return; }
    if (!Number.isInteger(perWeek) || perWeek < 1) { setError('Sessions per week must be at least 1.'); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/package-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: newLabel.trim(), total_sessions: total, sessions_per_week: perWeek }),
      });
      if (!res.ok) { setError((await res.json()).error || 'Failed to add type.'); return; }
      resetNew();
      await onChanged();
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (t: PackageTypeDef) => {
    setEditingId(t.id);
    setError(null);
    setEditState({
      label: t.label,
      total_sessions: String(t.total_sessions),
      sessions_per_week: String(t.sessions_per_week),
    });
  };

  const saveEdit = async (t: PackageTypeDef) => {
    setError(null);
    const total = parseInt(editState.total_sessions, 10);
    const perWeek = parseInt(editState.sessions_per_week, 10);
    if (!editState.label.trim()) { setError('Name cannot be empty.'); return; }
    if (!Number.isInteger(total) || total < 1) { setError('Total sessions must be at least 1.'); return; }
    if (!Number.isInteger(perWeek) || perWeek < 1) { setError('Sessions per week must be at least 1.'); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/package-types/${t.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: editState.label.trim(), total_sessions: total, sessions_per_week: perWeek }),
      });
      if (!res.ok) { setError((await res.json()).error || 'Failed to save.'); return; }
      setEditingId(null);
      await onChanged();
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (t: PackageTypeDef) => {
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/package-types/${t.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: !t.is_active }),
      });
      if (!res.ok) { setError((await res.json()).error || 'Failed to update.'); return; }
      await onChanged();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (t: PackageTypeDef) => {
    setError(null);
    setSaving(true);
    try {
      const res = await fetch(`/api/package-types/${t.id}`, { method: 'DELETE' });
      if (!res.ok) { setError((await res.json()).error || 'Failed to delete.'); return; }
      await onChanged();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Manage Package Types</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

        {/* Add custom type */}
        <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>Add a custom type</Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mb: 2 }}>
          <TextField
            label="Name *"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            fullWidth
            size="small"
            placeholder="e.g. 8 Weeks - 3x/week"
          />
          <Box sx={{ display: 'flex', gap: 1.5 }}>
            <TextField
              label="Total sessions *"
              value={newTotal}
              onChange={(e) => setNewTotal(e.target.value)}
              type="number"
              size="small"
              fullWidth
            />
            <TextField
              label="Sessions / week *"
              value={newPerWeek}
              onChange={(e) => setNewPerWeek(e.target.value)}
              type="number"
              size="small"
              fullWidth
              helperText="Drives the auto-scheduler"
            />
          </Box>
          <Box>
            <Button variant="contained" onClick={handleAdd} disabled={saving}>
              {saving ? 'Saving…' : 'Add type'}
            </Button>
          </Box>
        </Box>

        <Divider sx={{ my: 1 }} />

        <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>Existing types</Typography>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {types.map((t) => {
            const isEditing = editingId === t.id;
            return (
              <Box
                key={t.id}
                sx={{
                  border: 1,
                  borderColor: 'divider',
                  borderRadius: 1,
                  p: 1.25,
                  opacity: t.is_active ? 1 : 0.6,
                }}
              >
                {isEditing ? (
                  <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <TextField
                      label="Name"
                      value={editState.label}
                      onChange={(e) => setEditState((s) => ({ ...s, label: e.target.value }))}
                      size="small"
                      fullWidth
                    />
                    <Box sx={{ display: 'flex', gap: 1 }}>
                      <TextField
                        label="Total sessions"
                        value={editState.total_sessions}
                        onChange={(e) => setEditState((s) => ({ ...s, total_sessions: e.target.value }))}
                        type="number"
                        size="small"
                        fullWidth
                      />
                      <TextField
                        label="Sessions / week"
                        value={editState.sessions_per_week}
                        onChange={(e) => setEditState((s) => ({ ...s, sessions_per_week: e.target.value }))}
                        type="number"
                        size="small"
                        fullWidth
                      />
                    </Box>
                    <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 0.5 }}>
                      <IconButton color="primary" onClick={() => saveEdit(t)} disabled={saving} aria-label="Save">
                        <CheckIcon />
                      </IconButton>
                      <IconButton onClick={() => setEditingId(null)} disabled={saving} aria-label="Cancel">
                        <CloseIcon />
                      </IconButton>
                    </Box>
                  </Box>
                ) : (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Box sx={{ minWidth: 0, flexGrow: 1 }}>
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                        <Typography sx={{ fontWeight: 600 }}>{t.label}</Typography>
                        {t.is_builtin && <Chip label="Built-in" size="small" variant="outlined" />}
                        {!t.is_active && <Chip label="Inactive" size="small" color="default" />}
                      </Box>
                      <Typography variant="body2" color="text.secondary">
                        {t.total_sessions} sessions · {t.sessions_per_week}x/week
                      </Typography>
                    </Box>
                    <Tooltip title={t.is_active ? 'Active — shows in the dropdown' : 'Inactive — hidden from the dropdown'}>
                      <Switch
                        checked={t.is_active}
                        onChange={() => toggleActive(t)}
                        disabled={saving}
                        size="small"
                      />
                    </Tooltip>
                    <IconButton size="small" onClick={() => startEdit(t)} disabled={saving} aria-label="Edit">
                      <EditIcon fontSize="small" />
                    </IconButton>
                    <Tooltip title={t.is_builtin ? 'Built-in types cannot be deleted — deactivate instead' : 'Delete'}>
                      <span>
                        <IconButton
                          size="small"
                          color="error"
                          onClick={() => handleDelete(t)}
                          disabled={saving || t.is_builtin}
                          aria-label="Delete"
                        >
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Done</Button>
      </DialogActions>
    </Dialog>
  );
}
