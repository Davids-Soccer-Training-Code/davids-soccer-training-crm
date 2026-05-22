'use client';

import { useEffect, useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
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
import Divider from '@mui/material/Divider';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import VisibilityIcon from '@mui/icons-material/Visibility';
import LinkIcon from '@mui/icons-material/Link';
import Alert from '@mui/material/Alert';
import MenuItem from '@mui/material/MenuItem';

export const dynamic = 'force-dynamic';

const STARTING_EXPENSE_YEAR = 2026;
const EXPENSE_PAGE_SIZE = 25;
const DEFAULT_BUSINESS_PERCENTAGE = 100;
const ARIZONA_STATE_INCOME_TAX_RATE = 0.025;
const SELF_EMPLOYMENT_TAX_RATE = 0.153;
const SELF_EMPLOYMENT_TAXABLE_SHARE = 0.9235;
const FEDERAL_INCOME_TAX_ESTIMATE_RATE = 0.22;

interface Expense {
  id: number;
  expense_date: string;
  vendor: string;
  category: string;
  description: string | null;
  amount: number;
  payment_method: string | null;
  receipt_url: string | null;
  receipt_blob_path: string | null;
  business_percentage: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

interface ExpensesApiResponse {
  year: number;
  expenses: Expense[];
  total_count: number;
  limit: number;
  offset: number;
  totals: {
    gross_spent: number;
    business_spent: number;
  };
}

interface FinanceGoalsResponse {
  years?: {
    current: number;
    totals: Array<{
      year: number;
      total: number;
    }>;
  };
}

interface TaxEstimate {
  taxable_profit: number;
  self_employment_tax: number;
  federal_income_tax: number;
  arizona_income_tax: number;
  total_estimated_tax: number;
  suggested_quarterly_payment: number;
}

interface ExpenseFormState {
  expense_date: string;
  vendor: string;
  category: string;
  description: string;
  amount: string;
  payment_method: string;
  business_percentage: string;
  notes: string;
  receipt_file: File | null;
}

type ReceiptPreviewType = 'image' | 'pdf' | 'office' | 'unsupported';

interface ReceiptPreviewState {
  url: string;
  type: ReceiptPreviewType;
}

function getLocalDateIso(): string {
  const now = new Date();
  const tzOffsetMs = now.getTimezoneOffset() * 60 * 1000;
  return new Date(now.getTime() - tzOffsetMs).toISOString().slice(0, 10);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatExpenseDate(dateValue: string): string {
  const parts = dateValue.slice(0, 10).split('-');
  if (parts.length !== 3) return dateValue;
  return `${parts[1]}/${parts[2]}/${parts[0]}`;
}

function calculateTaxEstimate(
  revenue: number,
  businessSpent: number,
  federalRate: number,
  arizonaRate: number
): TaxEstimate {
  const taxableProfit = Math.max(0, revenue - businessSpent);
  const selfEmploymentTax = taxableProfit * SELF_EMPLOYMENT_TAXABLE_SHARE * SELF_EMPLOYMENT_TAX_RATE;
  const federalIncomeTax = taxableProfit * federalRate;
  const arizonaIncomeTax = taxableProfit * arizonaRate;
  const totalEstimatedTax = selfEmploymentTax + federalIncomeTax + arizonaIncomeTax;

  return {
    taxable_profit: round2(taxableProfit),
    self_employment_tax: round2(selfEmploymentTax),
    federal_income_tax: round2(federalIncomeTax),
    arizona_income_tax: round2(arizonaIncomeTax),
    total_estimated_tax: round2(totalEstimatedTax),
    suggested_quarterly_payment: round2(totalEstimatedTax / 4),
  };
}

function getFileExtension(value: string | null | undefined): string {
  if (!value) return '';

  const withoutQuery = value.split('?')[0];
  const lastSegment = withoutQuery.split('/').pop() || '';
  const match = lastSegment.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function getPreviewType(expense: Expense): ReceiptPreviewType {
  const extension =
    getFileExtension(expense.receipt_blob_path) || getFileExtension(expense.receipt_url);

  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tif', 'tiff', 'heic', 'heif'].includes(extension)) {
    return 'image';
  }

  if (extension === 'pdf') {
    return 'pdf';
  }

  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(extension)) {
    return 'office';
  }

  return 'unsupported';
}

const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const categorySuggestions = [
  'Business',
  'Tech',
  'Marketing',
  'Education',
  'Equipment',
  'Travel',
  'Insurance',
  'Subscriptions',
  'Business/Education',
];

export default function ExpensesPage() {
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(Math.max(STARTING_EXPENSE_YEAR, currentYear));
  const [data, setData] = useState<ExpensesApiResponse | null>(null);
  const [expensePage, setExpensePage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [preview, setPreview] = useState<ReceiptPreviewState | null>(null);
  const [saving, setSaving] = useState(false);
  const [revenueByYear, setRevenueByYear] = useState<Record<number, number>>({});
  const [taxRates, setTaxRates] = useState({
    federal: FEDERAL_INCOME_TAX_ESTIMATE_RATE,
    arizona: ARIZONA_STATE_INCOME_TAX_RATE,
  });
  const [form, setForm] = useState<ExpenseFormState>({
    expense_date: getLocalDateIso(),
    vendor: '',
    category: 'Business',
    description: '',
    amount: '',
    payment_method: '',
    business_percentage: String(DEFAULT_BUSINESS_PERCENTAGE),
    notes: '',
    receipt_file: null,
  });

  const yearOptions = useMemo(() => {
    const lastYear = Math.max(currentYear + 1, STARTING_EXPENSE_YEAR);
    const years: number[] = [];
    for (let year = STARTING_EXPENSE_YEAR; year <= lastYear; year += 1) {
      years.push(year);
    }
    return years.reverse();
  }, [currentYear]);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [expenseRes, financeRes] = await Promise.all([
        fetch(`/api/expenses?year=${selectedYear}&limit=${EXPENSE_PAGE_SIZE}&offset=${expensePage * EXPENSE_PAGE_SIZE}`, { cache: 'no-store' }),
        fetch('/api/finance-goals', { cache: 'no-store' }),
      ]);

      if (!expenseRes.ok) {
        throw new Error('Failed to load expenses');
      }

      const expenseJson = (await expenseRes.json()) as ExpensesApiResponse;
      setData(expenseJson);

      if (financeRes.ok) {
        const financeJson = (await financeRes.json()) as FinanceGoalsResponse;
        const yearlyTotals = financeJson.years?.totals ?? [];
        const map: Record<number, number> = {};
        yearlyTotals.forEach((item) => {
          map[item.year] = Number(item.total ?? 0);
        });
        setRevenueByYear(map);
      }
    } catch (err) {
      console.error(err);
      setError('Failed to load expenses data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedYear, expensePage]);

  const totalRevenue = round2(revenueByYear[selectedYear] ?? 0);
  const grossSpent = round2(data?.totals.gross_spent ?? 0);
  const businessSpent = round2(data?.totals.business_spent ?? 0);
  const netPayment = round2(totalRevenue - businessSpent);
  const taxEstimate = useMemo(() => {
    return calculateTaxEstimate(totalRevenue, businessSpent, taxRates.federal, taxRates.arizona);
  }, [businessSpent, taxRates.arizona, taxRates.federal, totalRevenue]);
  const totalExpenseCount = data?.total_count ?? 0;
  const visibleExpenseStart = totalExpenseCount === 0 ? 0 : expensePage * EXPENSE_PAGE_SIZE + 1;
  const visibleExpenseEnd = Math.min((expensePage + 1) * EXPENSE_PAGE_SIZE, totalExpenseCount);
  const hasNewerExpenses = expensePage > 0;
  const hasOlderExpenses = visibleExpenseEnd < totalExpenseCount;

  const resetForm = () => {
    setForm({
      expense_date: getLocalDateIso(),
      vendor: '',
      category: 'Business',
      description: '',
      amount: '',
      payment_method: '',
      business_percentage: String(DEFAULT_BUSINESS_PERCENTAGE),
      notes: '',
      receipt_file: null,
    });
  };

  const closeExpenseDialog = () => {
    setDialogOpen(false);
    setEditingExpense(null);
    resetForm();
  };

  const openCreateDialog = () => {
    setEditingExpense(null);
    resetForm();
    setDialogOpen(true);
  };

  const openEditDialog = (expense: Expense) => {
    setEditingExpense(expense);
    setForm({
      expense_date: expense.expense_date.slice(0, 10),
      vendor: expense.vendor,
      category: expense.category,
      description: expense.description || '',
      amount: String(expense.amount),
      payment_method: expense.payment_method || '',
      business_percentage: String(expense.business_percentage),
      notes: expense.notes || '',
      receipt_file: null,
    });
    setDialogOpen(true);
  };

  const handleSaveExpense = async () => {
    const amount = Number(form.amount);
    const businessPercentage = Number(form.business_percentage || DEFAULT_BUSINESS_PERCENTAGE);

    if (!form.expense_date || !form.vendor.trim() || !form.category.trim() || !Number.isFinite(amount)) {
      setError('Date, vendor, category, and amount are required.');
      return;
    }

    if (!Number.isFinite(businessPercentage) || businessPercentage < 0 || businessPercentage > 100) {
      setError('Business percentage must be between 0 and 100.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      let receiptUrl: string | null = editingExpense?.receipt_url ?? null;
      let receiptBlobPath: string | null = editingExpense?.receipt_blob_path ?? null;

      if (form.receipt_file) {
        const uploadFormData = new FormData();
        uploadFormData.append('file', form.receipt_file);
        uploadFormData.append('year', form.expense_date.slice(0, 4));

        const uploadRes = await fetch('/api/expenses/upload-receipt', {
          method: 'POST',
          body: uploadFormData,
        });

        if (!uploadRes.ok) {
          const uploadErr = await uploadRes.json().catch(() => ({ error: 'Upload failed' }));
          throw new Error(uploadErr.error || 'Failed to upload receipt');
        }

        const uploadJson = await uploadRes.json();
        receiptUrl = uploadJson.url;
        receiptBlobPath = uploadJson.pathname;
      }

      const endpoint = editingExpense ? `/api/expenses/${editingExpense.id}` : '/api/expenses';
      const method = editingExpense ? 'PATCH' : 'POST';

      const saveRes = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expense_date: form.expense_date,
          vendor: form.vendor.trim(),
          category: form.category.trim(),
          description: form.description.trim() || null,
          amount,
          payment_method: form.payment_method.trim() || null,
          receipt_url: receiptUrl,
          receipt_blob_path: receiptBlobPath,
          business_percentage: businessPercentage,
          notes: form.notes.trim() || null,
        }),
      });

      if (!saveRes.ok) {
        const saveErr = await saveRes.json().catch(() => ({ error: 'Save failed' }));
        throw new Error(saveErr.error || 'Failed to save expense');
      }

      closeExpenseDialog();
      if (editingExpense || expensePage === 0) {
        await fetchData();
      } else {
        setExpensePage(0);
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to save expense');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteExpense = async (id: number) => {
    const confirmed = window.confirm('Delete this expense? This cannot be undone.');
    if (!confirmed) return;

    try {
      const res = await fetch(`/api/expenses/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({ error: 'Delete failed' }));
        throw new Error(payload.error || 'Failed to delete expense');
      }
      await fetchData();
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to delete expense');
    }
  };

  if (loading) {
    return <Typography>Loading expenses...</Typography>;
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, mb: 3, flexWrap: 'wrap' }}>
        <Typography variant="h4" sx={{ fontWeight: 700 }}>
          Expenses
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <TextField
            select
            size="small"
            label="Year"
            value={selectedYear}
            onChange={(e) => {
              setSelectedYear(Number(e.target.value));
              setExpensePage(0);
            }}
            sx={{ minWidth: 120 }}
          >
            {yearOptions.map((year) => (
              <MenuItem key={year} value={year}>
                {year}
              </MenuItem>
            ))}
          </TextField>
          <Button variant="contained" startIcon={<AddIcon />} onClick={openCreateDialog}>
            Add Expense
          </Button>
        </Box>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      <Card sx={{ mb: 3 }}>
        <CardContent sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, flexWrap: 'wrap', pb: 1 }}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 700 }}>
              Recent Expenses
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {totalExpenseCount === 0
                ? `No expenses for ${selectedYear}`
                : `Showing ${visibleExpenseStart}-${visibleExpenseEnd} of ${totalExpenseCount}`}
            </Typography>
          </Box>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button
              size="small"
              variant="outlined"
              disabled={!hasNewerExpenses}
              onClick={() => setExpensePage((prev) => Math.max(0, prev - 1))}
            >
              Newer 25
            </Button>
            <Button
              size="small"
              variant="outlined"
              disabled={!hasOlderExpenses}
              onClick={() => setExpensePage((prev) => prev + 1)}
            >
              Older 25
            </Button>
          </Box>
        </CardContent>
        <CardContent sx={{ p: 0 }}>
          <TableContainer component={Paper} elevation={0}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Date</TableCell>
                  <TableCell>Vendor</TableCell>
                  <TableCell>Category</TableCell>
                  <TableCell>Description</TableCell>
                  <TableCell align="right">Amount</TableCell>
                  <TableCell>Payment Method</TableCell>
                  <TableCell>Receipt</TableCell>
                  <TableCell align="right">Business %</TableCell>
                  <TableCell>Notes</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {(data?.expenses || []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} sx={{ py: 5, textAlign: 'center', color: 'text.secondary' }}>
                      No expenses found for {selectedYear}. Add your first expense for this year.
                    </TableCell>
                  </TableRow>
                ) : (
                  (data?.expenses || []).map((expense) => (
                    <TableRow key={expense.id} hover>
                      <TableCell>{formatExpenseDate(expense.expense_date)}</TableCell>
                      <TableCell>{expense.vendor}</TableCell>
                      <TableCell>
                        <Chip size="small" label={expense.category} />
                      </TableCell>
                      <TableCell>{expense.description || '-'}</TableCell>
                      <TableCell align="right">{money.format(expense.amount)}</TableCell>
                      <TableCell>{expense.payment_method || '-'}</TableCell>
                      <TableCell>
                        {expense.receipt_url ? (
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            <IconButton
                              size="small"
                              onClick={() =>
                                setPreview({
                                  url: expense.receipt_url!,
                                  type: getPreviewType(expense),
                                })
                              }
                              title="Preview receipt"
                            >
                              <VisibilityIcon fontSize="small" />
                            </IconButton>
                            <IconButton
                              size="small"
                              onClick={() => window.open(expense.receipt_url!, '_blank', 'noopener,noreferrer')}
                              title="Open receipt link"
                            >
                              <LinkIcon fontSize="small" />
                            </IconButton>
                          </Box>
                        ) : (
                          '-'
                        )}
                      </TableCell>
                      <TableCell align="right">{expense.business_percentage.toFixed(0)}%</TableCell>
                      <TableCell>{expense.notes || '-'}</TableCell>
                      <TableCell align="right">
                        <IconButton
                          color="primary"
                          size="small"
                          onClick={() => openEditDialog(expense)}
                        >
                          <EditIcon fontSize="small" />
                        </IconButton>
                        <IconButton color="error" size="small" onClick={() => handleDeleteExpense(expense.id)}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
        {totalExpenseCount > EXPENSE_PAGE_SIZE && (
          <CardContent sx={{ display: 'flex', justifyContent: 'flex-end', gap: 1, pt: 1 }}>
            <Button
              size="small"
              variant="outlined"
              disabled={!hasNewerExpenses}
              onClick={() => setExpensePage((prev) => Math.max(0, prev - 1))}
            >
              Newer 25
            </Button>
            <Button
              size="small"
              variant="contained"
              disabled={!hasOlderExpenses}
              onClick={() => setExpensePage((prev) => prev + 1)}
            >
              Older 25
            </Button>
          </CardContent>
        )}
      </Card>

      <Typography variant="h6" sx={{ fontWeight: 700, mb: 1.5 }}>
        Year Summary ({selectedYear})
      </Typography>
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr 1fr' }, gap: 2, mb: 3 }}>
        <Card>
          <CardContent>
            <Typography variant="overline" color="text.secondary">
              Money Officially In
            </Typography>
            <Typography variant="h5" sx={{ fontWeight: 700 }}>
              {money.format(totalRevenue)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Revenue pulled from Finance Goals API yearly totals
            </Typography>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Typography variant="overline" color="text.secondary">
              Money Spent (Business)
            </Typography>
            <Typography variant="h5" sx={{ fontWeight: 700 }}>
              {money.format(businessSpent)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Gross expenses: {money.format(grossSpent)}
            </Typography>
          </CardContent>
        </Card>
        <Card>
          <CardContent>
            <Typography variant="overline" color="text.secondary">
              Net Payment
            </Typography>
            <Typography
              variant="h5"
              sx={{ fontWeight: 700, color: netPayment >= 0 ? 'success.main' : 'error.main' }}
            >
              {money.format(netPayment)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              Net = revenue - business expenses
            </Typography>
          </CardContent>
        </Card>
      </Box>

      <Card>
        <CardContent>
          <Typography variant="h6" sx={{ fontWeight: 700, mb: 0.5 }}>
            Arizona Tax Estimate ({selectedYear})
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Estimates use self-employment tax (15.3% of 92.35% net). You can adjust federal and Arizona rates below.
          </Typography>
          <Box sx={{ display: 'flex', gap: 1.5, mb: 2, flexWrap: 'wrap' }}>
            <TextField
              label="Federal Rate %"
              type="number"
              value={(taxRates.federal * 100).toFixed(2)}
              onChange={(e) =>
                setTaxRates((prev) => ({
                  ...prev,
                  federal: Math.min(100, Math.max(0, Number(e.target.value || 0))) / 100,
                }))
              }
              size="small"
              sx={{ width: 170 }}
              slotProps={{ htmlInput: { min: 0, max: 100, step: '0.01' } }}
            />
            <TextField
              label="Arizona Rate %"
              type="number"
              value={(taxRates.arizona * 100).toFixed(2)}
              onChange={(e) =>
                setTaxRates((prev) => ({
                  ...prev,
                  arizona: Math.min(100, Math.max(0, Number(e.target.value || 0))) / 100,
                }))
              }
              size="small"
              sx={{ width: 170 }}
              slotProps={{ htmlInput: { min: 0, max: 100, step: '0.01' } }}
            />
          </Box>
          <Divider sx={{ mb: 2 }} />
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: '1fr 1fr 1fr' }, gap: 2 }}>
            <Card variant="outlined">
              <CardContent>
                <Typography variant="caption" color="text.secondary">Taxable Profit</Typography>
                <Typography variant="h6" sx={{ fontWeight: 700 }}>{money.format(taxEstimate.taxable_profit)}</Typography>
              </CardContent>
            </Card>
            <Card variant="outlined">
              <CardContent>
                <Typography variant="caption" color="text.secondary">Self-Employment Tax</Typography>
                <Typography variant="h6" sx={{ fontWeight: 700 }}>{money.format(taxEstimate.self_employment_tax)}</Typography>
              </CardContent>
            </Card>
            <Card variant="outlined">
              <CardContent>
                <Typography variant="caption" color="text.secondary">Federal Income Tax</Typography>
                <Typography variant="h6" sx={{ fontWeight: 700 }}>{money.format(taxEstimate.federal_income_tax)}</Typography>
              </CardContent>
            </Card>
            <Card variant="outlined">
              <CardContent>
                <Typography variant="caption" color="text.secondary">Arizona Income Tax</Typography>
                <Typography variant="h6" sx={{ fontWeight: 700 }}>{money.format(taxEstimate.arizona_income_tax)}</Typography>
              </CardContent>
            </Card>
            <Card variant="outlined">
              <CardContent>
                <Typography variant="caption" color="text.secondary">Total Estimated Taxes</Typography>
                <Typography variant="h6" sx={{ fontWeight: 700 }}>{money.format(taxEstimate.total_estimated_tax)}</Typography>
              </CardContent>
            </Card>
            <Card variant="outlined">
              <CardContent>
                <Typography variant="caption" color="text.secondary">Suggested Quarterly Payment</Typography>
                <Typography variant="h6" sx={{ fontWeight: 700 }}>{money.format(taxEstimate.suggested_quarterly_payment)}</Typography>
              </CardContent>
            </Card>
          </Box>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onClose={() => !saving && closeExpenseDialog()} maxWidth="sm" fullWidth>
        <DialogTitle>{editingExpense ? 'Edit Expense' : 'Add Expense'}</DialogTitle>
        <DialogContent>
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
            <TextField
              label="Date"
              type="date"
              value={form.expense_date}
              onChange={(e) => setForm((prev) => ({ ...prev, expense_date: e.target.value }))}
              slotProps={{ inputLabel: { shrink: true } }}
              fullWidth
              required
            />
            <TextField
              label="Vendor"
              value={form.vendor}
              onChange={(e) => setForm((prev) => ({ ...prev, vendor: e.target.value }))}
              fullWidth
              required
            />
            <TextField
              select
              label="Category"
              value={form.category}
              onChange={(e) => setForm((prev) => ({ ...prev, category: e.target.value }))}
              fullWidth
            >
              {categorySuggestions.map((category) => (
                <MenuItem key={category} value={category}>
                  {category}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="Description"
              value={form.description}
              onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
              fullWidth
            />
            <TextField
              label="Amount"
              type="number"
              value={form.amount}
              onChange={(e) => setForm((prev) => ({ ...prev, amount: e.target.value }))}
              fullWidth
              required
              slotProps={{ htmlInput: { min: 0, step: '0.01' } }}
            />
            <TextField
              label="Payment Method"
              value={form.payment_method}
              onChange={(e) => setForm((prev) => ({ ...prev, payment_method: e.target.value }))}
              fullWidth
            />
            <TextField
              label="Business %"
              type="number"
              value={form.business_percentage}
              onChange={(e) => setForm((prev) => ({ ...prev, business_percentage: e.target.value }))}
              fullWidth
              slotProps={{ htmlInput: { min: 0, max: 100, step: '0.01' } }}
            />
            <TextField
              label="Notes"
              value={form.notes}
              onChange={(e) => setForm((prev) => ({ ...prev, notes: e.target.value }))}
              fullWidth
              multiline
              minRows={2}
            />
            <Box>
              <Button component="label" variant="outlined" startIcon={<UploadFileIcon />}>
                {editingExpense?.receipt_url ? 'Replace Receipt' : 'Upload Receipt'}
                <input
                  hidden
                  type="file"
                  accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
                  onChange={(e) =>
                    setForm((prev) => ({ ...prev, receipt_file: e.target.files?.[0] ?? null }))
                  }
                />
              </Button>
              {form.receipt_file && (
                <Typography variant="body2" sx={{ mt: 1 }} color="text.secondary">
                  Selected: {form.receipt_file.name}
                </Typography>
              )}
              {!form.receipt_file && editingExpense?.receipt_url && (
                <Typography variant="body2" sx={{ mt: 1 }} color="text.secondary">
                  Current receipt is attached. Upload a new file to replace it.
                </Typography>
              )}
            </Box>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeExpenseDialog} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSaveExpense} variant="contained" disabled={saving}>
            {saving ? 'Saving...' : editingExpense ? 'Update Expense' : 'Save Expense'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(preview)} onClose={() => setPreview(null)} maxWidth="md" fullWidth>
        <DialogTitle>Receipt Preview</DialogTitle>
        <DialogContent>
          {preview && (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {preview.type === 'image' && (
                <Box
                  component="img"
                  src={preview.url}
                  alt="Receipt preview"
                  sx={{
                    width: '100%',
                    maxHeight: '75vh',
                    objectFit: 'contain',
                    borderRadius: 1,
                    border: '1px solid',
                    borderColor: 'divider',
                  }}
                />
              )}

              {preview.type === 'pdf' && (
                <Box
                  component="iframe"
                  src={preview.url}
                  title="PDF receipt preview"
                  sx={{
                    width: '100%',
                    height: '75vh',
                    borderRadius: 1,
                    border: '1px solid',
                    borderColor: 'divider',
                    backgroundColor: 'white',
                  }}
                />
              )}

              {preview.type === 'office' && (
                <Box
                  component="iframe"
                  src={`https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(preview.url)}`}
                  title="Office document preview"
                  sx={{
                    width: '100%',
                    height: '75vh',
                    borderRadius: 1,
                    border: '1px solid',
                    borderColor: 'divider',
                    backgroundColor: 'white',
                  }}
                />
              )}

              {preview.type === 'unsupported' && (
                <Alert severity="info">
                  Preview is not available for this file type. Use “Open Original Receipt”.
                </Alert>
              )}

              <Button href={preview.url} target="_blank" rel="noopener noreferrer" variant="outlined">
                Open Original Receipt
              </Button>
            </Box>
          )}
        </DialogContent>
      </Dialog>
    </Box>
  );
}
