'use client';

import { useState, useEffect } from 'react';
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
import DeleteIcon from '@mui/icons-material/Delete';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import type { Parent } from '@/lib/types';

const packageTypeLabels: Record<string, string> = {
  '12_week_1x': '12 Weeks - 1x/week (12 sessions)',
  '12_week_2x': '12 Weeks - 2x/week (24 sessions)',
  '6_week_1x': '6 Weeks - 1x/week (6 sessions)',
  '6_week_2x': '6 Weeks - 2x/week (12 sessions)',
};

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
  total_sessions: number;
  sessions_completed: number;
  price: number | string | null;
  amount_received: number | string | null;
  start_date: string | null;
  is_active: boolean;
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

  useEffect(() => { fetchPackages(); }, []);

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
      }),
    });
    if (res.ok) {
      setDialogOpen(false);
      setParentId('');
      setPackageType('');
      setPrice('');
      setStartDate('');
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
                  {packageTypeLabels[pkg.package_type] || pkg.package_type}
                </Typography>
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
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setDialogOpen(true)}>
          New Package
        </Button>
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
            <TextField label="Package Type *" value={packageType} onChange={(e) => setPackageType(e.target.value)} select fullWidth>
              {Object.entries(packageTypeLabels).map(([val, label]) => (
                <MenuItem key={val} value={val}>{label}</MenuItem>
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
