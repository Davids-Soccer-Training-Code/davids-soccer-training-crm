'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardActionArea from '@mui/material/CardActionArea';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import Typography from '@mui/material/Typography';
import Chip from '@mui/material/Chip';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import MenuItem from '@mui/material/MenuItem';
import LinearProgress from '@mui/material/LinearProgress';
import IconButton from '@mui/material/IconButton';
import AddIcon from '@mui/icons-material/Add';
import BadgeIcon from '@mui/icons-material/Badge';
import DeleteIcon from '@mui/icons-material/Delete';
import TuneIcon from '@mui/icons-material/Tune';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { Parent, PackageTypeDef } from '@/lib/types';
import ManageTypesDialog from './ManageTypesDialog';

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

interface PackageRow {
  id: number;
  parent_id: number;
  parent_name: string;
  player_names: string[] | null;
  package_type: string;
  package_type_label: string | null;
  total_sessions: number;
  sessions_completed: number;
  price: number | string | null;
  amount_received: number | string | null;
  start_date: string | null;
  is_active: boolean;
  coach_id: number | null;
  coach_name: string | null;
}

type ParentOption = Parent & {
  player_names?: string[] | null;
};

export const dynamic = 'force-dynamic';

export default function PackagesPage() {
  const router = useRouter();
  const [packages, setPackages] = useState<PackageRow[]>([]);
  const [parents, setParents] = useState<ParentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [parentId, setParentId] = useState('');
  const [packageType, setPackageType] = useState('');
  const [price, setPrice] = useState('');
  const [startDate, setStartDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PackageRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [staff, setStaff] = useState<{ id: number; name: string }[]>([]);
  const [coachId, setCoachId] = useState('');
  const coachTouchedRef = useRef(false);
  const [packageTypes, setPackageTypes] = useState<PackageTypeDef[]>([]);
  const [manageOpen, setManageOpen] = useState(false);

  const activePackageTypes = packageTypes.filter((t) => t.is_active);

  const fetchPackageTypes = async () => {
    const res = await fetch('/api/package-types?include_inactive=1');
    if (res.ok) setPackageTypes(await res.json());
  };

  const fetchPackages = async () => {
    setLoading(true);
    const [pkgRes, parRes] = await Promise.all([
      fetch('/api/packages'),
      fetch('/api/parents'),
    ]);
    if (pkgRes.ok) setPackages(await pkgRes.json());
    if (parRes.ok) setParents(await parRes.json());
    setLoading(false);
  };

  useEffect(() => { fetchPackages(); fetchPackageTypes(); }, []);

  useEffect(() => {
    fetch('/api/staff').then((r) => r.json()).then((rows) =>
      setStaff(rows.map((s: { id: number; name: string }) => ({ id: s.id, name: s.name })))
    );
  }, []);

  // Autofill coach from the selected parent's players (unless the user overrode it)
  useEffect(() => {
    if (!parentId) { setCoachId(''); coachTouchedRef.current = false; return; }
    if (coachTouchedRef.current) return;
    fetch(`/api/parents/${parentId}/players`)
      .then((r) => r.json())
      .then((players: { coach_id?: number | null }[]) => {
        if (coachTouchedRef.current) return;
        const withCoach = players.find((pl) => pl.coach_id != null);
        setCoachId(withCoach?.coach_id != null ? String(withCoach.coach_id) : '');
      })
      .catch(() => {});
  }, [parentId]);

  const handleCreate = async () => {
    if (!parentId || !packageType) return;
    setSaving(true);
    const res = await fetch('/api/packages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parent_id: parseInt(parentId),
        package_type: packageType,
        price: price ? parseFloat(price) : null,
        start_date: startDate || null,
        coach_id: coachId ? parseInt(coachId) : null,
      }),
    });
    if (res.ok) {
      setDialogOpen(false);
      setParentId('');
      setPackageType('');
      setPrice('');
      setStartDate('');
      setCoachId('');
      coachTouchedRef.current = false;
      fetchPackages();
    }
    setSaving(false);
  };

  const handleDeletePackage = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/packages/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) return;
      setDeleteTarget(null);
      await fetchPackages();
    } finally {
      setDeleting(false);
    }
  };

  if (loading) return <Typography>Loading...</Typography>;

  const activePackages = packages.filter((pkg) => pkg.is_active);
  const completedPackages = packages.filter((pkg) => !pkg.is_active);

  const renderPackageCard = (pkg: PackageRow) => {
    const progress = pkg.total_sessions > 0 ? Math.min((pkg.sessions_completed / pkg.total_sessions) * 100, 100) : 0;
    const packagePrice = Number(pkg.price ?? 0);
    const amountReceived = Number(pkg.amount_received ?? 0);
    const hasPrice = packagePrice > 0;
    const safeAmountReceived = hasPrice ? Math.min(amountReceived, packagePrice) : amountReceived;
    const paymentProgress = hasPrice ? Math.min((safeAmountReceived / packagePrice) * 100, 100) : 0;

    return (
      <Card
        key={pkg.id}
        variant="outlined"
        sx={{
          borderLeft: 4,
          borderColor: pkg.is_active ? 'success.main' : 'divider',
        }}
      >
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', px: 1, pt: 1 }}>
          <IconButton
            size="small"
            color="error"
            aria-label="Delete package"
            onClick={(event) => {
              event.stopPropagation();
              setDeleteTarget(pkg);
            }}
          >
            <DeleteIcon fontSize="small" />
          </IconButton>
        </Box>
        <CardActionArea onClick={() => router.push(`/packages/${pkg.id}`)}>
          <CardContent sx={{ pt: 0.5, pb: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, mb: 1 }}>
              <Box sx={{ minWidth: 0 }}>
                <Typography sx={{ fontWeight: 700 }}>
                  {pkg.parent_name}
                  {pkg.player_names && pkg.player_names.length > 0 && (
                    <Typography component="span" sx={{ fontWeight: 400, color: 'text.secondary', ml: 1 }}>
                      ({pkg.player_names.join(', ')})
                    </Typography>
                  )}
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  {pkg.package_type_label || pkg.package_type}
                </Typography>
                <Chip
                  icon={<BadgeIcon />}
                  label={pkg.coach_name ? `Coach: ${pkg.coach_name}` : 'No coach assigned'}
                  color={pkg.coach_name ? 'primary' : 'warning'}
                  variant={pkg.coach_name ? 'filled' : 'outlined'}
                  size="small"
                  sx={{ mt: 0.5 }}
                />
              </Box>
              <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
                <Chip label={pkg.is_active ? 'Still Doing' : 'Completed'} color={pkg.is_active ? 'success' : 'default'} size="small" />
                {pkg.price != null && <Typography variant="body2" sx={{ mt: 0.5 }}>{currency.format(packagePrice)}</Typography>}
              </Box>
            </Box>

            <Box sx={{ mt: 1, display: 'grid', gap: 1.25, gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' } }}>
              <Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                  <Typography variant="body2" color="text.secondary">Sessions</Typography>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {pkg.sessions_completed}/{pkg.total_sessions}
                  </Typography>
                </Box>
                <LinearProgress variant="determinate" value={progress} sx={{ height: 8, borderRadius: 4 }} />
              </Box>

              <Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                  <Typography variant="body2" color="text.secondary">Payment</Typography>
                  <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {hasPrice
                      ? `${currency.format(safeAmountReceived)} / ${currency.format(packagePrice)}`
                      : `${currency.format(amountReceived)} received`}
                  </Typography>
                </Box>
                <LinearProgress
                  variant="determinate"
                  value={paymentProgress}
                  color="success"
                  sx={{ height: 8, borderRadius: 4 }}
                />
              </Box>
            </Box>
          </CardContent>
        </CardActionArea>
      </Card>
    );
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Typography variant="h4" sx={{ fontWeight: 700 }}>Packages</Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button variant="outlined" startIcon={<TuneIcon />} onClick={() => setManageOpen(true)}>
            Manage Types
          </Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setDialogOpen(true)}>
            New Package
          </Button>
        </Box>
      </Box>

      {packages.length === 0 ? (
        <Card variant="outlined">
          <CardContent sx={{ textAlign: 'center', py: 6 }}>
            <Typography color="text.secondary">No packages yet. Create one for a client!</Typography>
          </CardContent>
        </Card>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
              Still Doing ({activePackages.length})
            </Typography>
            {activePackages.length === 0 ? (
              <Card variant="outlined">
                <CardContent>
                  <Typography color="text.secondary" variant="body2">No active packages right now.</Typography>
                </CardContent>
              </Card>
            ) : (
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                {activePackages.map(renderPackageCard)}
              </Box>
            )}
          </Box>

          <Accordion disableGutters>
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              <Typography sx={{ fontWeight: 700 }}>
                Completed Packages ({completedPackages.length})
              </Typography>
            </AccordionSummary>
            <AccordionDetails sx={{ pt: 0 }}>
              {completedPackages.length === 0 ? (
                <Typography color="text.secondary" variant="body2">No completed packages yet.</Typography>
              ) : (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                  {completedPackages.map(renderPackageCard)}
                </Box>
              )}
            </AccordionDetails>
          </Accordion>
        </Box>
      )}

      {/* Create Package Dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Create Package Deal</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
            <TextField label="Parent *" value={parentId} onChange={(e) => setParentId(e.target.value)} select fullWidth>
              {parents.map((p) => (
                <MenuItem key={p.id} value={p.id}>
                  {p.name}
                  {p.player_names && p.player_names.length > 0 && ` (${p.player_names.join(', ')})`}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="Package Type *"
              value={packageType}
              onChange={(e) => setPackageType(e.target.value)}
              select
              fullWidth
              helperText={
                <Box component="span" sx={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <Box
                    component="span"
                    role="button"
                    tabIndex={0}
                    onClick={() => setManageOpen(true)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setManageOpen(true); }}
                    sx={{ cursor: 'pointer', color: 'primary.main' }}
                  >
                    + Manage / add custom types
                  </Box>
                </Box>
              }
            >
              {activePackageTypes.map((t) => (
                <MenuItem key={t.key} value={t.key}>{t.label}</MenuItem>
              ))}
            </TextField>
            <TextField
              label="Coach"
              value={coachId}
              onChange={(e) => { coachTouchedRef.current = true; setCoachId(e.target.value); }}
              select
              fullWidth
              helperText="Autofills from the parent's assigned coach; change if needed."
            >
              <MenuItem value="">— None —</MenuItem>
              {staff.map((s) => (
                <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>
              ))}
            </TextField>
            <TextField label="Total Price ($)" value={price} onChange={(e) => setPrice(e.target.value)} type="number" fullWidth />
            <TextField label="Start Date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} fullWidth slotProps={{ inputLabel: { shrink: true } }} />
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
          <Button onClick={handleCreate} variant="contained" disabled={saving || !parentId || !packageType}>
            {saving ? 'Creating...' : 'Create'}
          </Button>
        </DialogActions>
      </Dialog>

      <ManageTypesDialog
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        types={packageTypes}
        onChanged={fetchPackageTypes}
      />

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete Package?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {deleteTarget
              ? `Delete package for ${deleteTarget.parent_name}? This keeps session records but unlinks them from this package.`
              : ''}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)} disabled={deleting}>
            Cancel
          </Button>
          <Button color="error" variant="contained" onClick={handleDeletePackage} disabled={deleting}>
            {deleting ? 'Deleting...' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
