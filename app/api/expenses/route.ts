import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { jsonResponse, errorResponse } from '@/lib/api-helpers';
import {
  MIN_EXPENSE_YEAR,
  ensureExpensesSchema,
  getExpenseYearBounds,
  normalizeExpenseYear,
} from '@/lib/expenses-db';

export const dynamic = 'force-dynamic';

const DEFAULT_EXPENSE_LIMIT = 25;
const MAX_EXPENSE_LIMIT = 100;

interface ExpenseRow {
  id: number;
  expense_date: string;
  vendor: string;
  category: string;
  description: string | null;
  amount: string | number;
  payment_method: string | null;
  receipt_url: string | null;
  receipt_blob_path: string | null;
  business_percentage: string | number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function asNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function mapExpense(row: ExpenseRow) {
  return {
    ...row,
    amount: round2(asNumber(row.amount)),
    business_percentage: round2(asNumber(row.business_percentage)),
    expense_date: String(row.expense_date).slice(0, 10),
  };
}

function isValidDateString(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime());
}

export async function GET(request: NextRequest) {
  try {
    await ensureExpensesSchema();

    const year = normalizeExpenseYear(request.nextUrl.searchParams.get('year'));
    const limitRaw = Number(request.nextUrl.searchParams.get('limit') ?? DEFAULT_EXPENSE_LIMIT);
    const offsetRaw = Number(request.nextUrl.searchParams.get('offset') ?? 0);
    const limit = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(MAX_EXPENSE_LIMIT, Math.trunc(limitRaw)))
      : DEFAULT_EXPENSE_LIMIT;
    const offset = Number.isFinite(offsetRaw)
      ? Math.max(0, Math.trunc(offsetRaw))
      : 0;
    const { start, end } = getExpenseYearBounds(year);

    const [expensesResult, totalsResult, countResult] = await Promise.all([
      query(
        `
          SELECT
            id,
            expense_date::text AS expense_date,
            vendor,
            category,
            description,
            amount::numeric AS amount,
            payment_method,
            receipt_url,
            receipt_blob_path,
            business_percentage::numeric AS business_percentage,
            notes,
            created_at,
            updated_at
          FROM crm_expenses
          WHERE expense_date >= $1::date
            AND expense_date < $2::date
          ORDER BY expense_date DESC, id DESC
          LIMIT $3
          OFFSET $4
        `,
        [start, end, limit, offset]
      ),
      query(
        `
          SELECT
            COALESCE(SUM(amount), 0)::numeric AS gross_spent,
            COALESCE(SUM(amount * (business_percentage / 100.0)), 0)::numeric AS business_spent
          FROM crm_expenses
          WHERE expense_date >= $1::date
            AND expense_date < $2::date
        `,
        [start, end]
      ),
      query(
        `
          SELECT COUNT(*)::int AS total_count
          FROM crm_expenses
          WHERE expense_date >= $1::date
            AND expense_date < $2::date
        `,
        [start, end]
      ),
    ]);

    const totals = totalsResult.rows[0] ?? { gross_spent: 0, business_spent: 0 };
    const count = countResult.rows[0] ?? { total_count: 0 };
    const expenses = (expensesResult.rows as ExpenseRow[]).map(mapExpense);

    return jsonResponse({
      year,
      expenses,
      total_count: Number(count.total_count ?? 0),
      limit,
      offset,
      totals: {
        gross_spent: round2(asNumber(totals.gross_spent)),
        business_spent: round2(asNumber(totals.business_spent)),
      },
    });
  } catch (error) {
    console.error('Error fetching expenses:', error);
    return errorResponse('Failed to fetch expenses');
  }
}

export async function POST(request: NextRequest) {
  try {
    await ensureExpensesSchema();

    const body = await request.json();
    const expenseDate = String(body.expense_date || '');
    const vendor = String(body.vendor || '').trim();
    const category = String(body.category || '').trim();
    const amount = Number(body.amount);
    const description = body.description == null ? null : String(body.description).trim() || null;
    const paymentMethod = body.payment_method == null ? null : String(body.payment_method).trim() || null;
    const receiptUrl = body.receipt_url == null ? null : String(body.receipt_url).trim() || null;
    const receiptBlobPath =
      body.receipt_blob_path == null ? null : String(body.receipt_blob_path).trim() || null;
    const notes = body.notes == null ? null : String(body.notes).trim() || null;

    const businessPercentageRaw =
      body.business_percentage == null ? 100 : Number(body.business_percentage);

    if (!vendor || !category || !isValidDateString(expenseDate) || !Number.isFinite(amount)) {
      return errorResponse('Date, vendor, category, and amount are required', 400);
    }

    if (amount < 0) {
      return errorResponse('Amount must be zero or greater', 400);
    }

    if (
      !Number.isFinite(businessPercentageRaw) ||
      businessPercentageRaw < 0 ||
      businessPercentageRaw > 100
    ) {
      return errorResponse('Business percentage must be between 0 and 100', 400);
    }

    const expenseYear = Number(expenseDate.slice(0, 4));
    if (expenseYear < MIN_EXPENSE_YEAR) {
      return errorResponse(`Expense year must be ${MIN_EXPENSE_YEAR} or later`, 400);
    }

    const result = await query(
      `
        INSERT INTO crm_expenses (
          expense_date,
          vendor,
          category,
          description,
          amount,
          payment_method,
          receipt_url,
          receipt_blob_path,
          business_percentage,
          notes
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING
          id,
          expense_date::text AS expense_date,
          vendor,
          category,
          description,
          amount::numeric AS amount,
          payment_method,
          receipt_url,
          receipt_blob_path,
          business_percentage::numeric AS business_percentage,
          notes,
          created_at,
          updated_at
      `,
      [
        expenseDate,
        vendor,
        category,
        description,
        amount,
        paymentMethod,
        receiptUrl,
        receiptBlobPath,
        businessPercentageRaw,
        notes,
      ]
    );

    return jsonResponse(mapExpense(result.rows[0] as ExpenseRow), 201);
  } catch (error) {
    console.error('Error creating expense:', error);
    return errorResponse('Failed to create expense');
  }
}
