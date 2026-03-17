import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { jsonResponse, errorResponse } from '@/lib/api-helpers';

export const dynamic = 'force-dynamic';

function normalizeOptionalText(value: unknown): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeRequiredText(value: unknown): string | null {
  const normalized = normalizeOptionalText(value);
  return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeOptionalAge(value: unknown): number | null | undefined {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

function normalizeOptionalBirthday(value: unknown): string | null | undefined {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  return raw;
}

function normalizeOptionalMoney(value: unknown): number | null | undefined {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.round(parsed * 100) / 100;
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json();
    let requestedHasPaid: boolean | null = null;
    let requestedAmountPaid: number | null | undefined;

    const fields: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if ('first_name' in body) {
      const firstName = normalizeRequiredText(body.first_name);
      if (!firstName) return errorResponse('First name is required', 400);
      fields.push(`first_name = $${paramIndex++}`);
      values.push(firstName);
    }

    if ('last_name' in body) {
      const lastName = normalizeRequiredText(body.last_name);
      if (!lastName) return errorResponse('Last name is required', 400);
      fields.push(`last_name = $${paramIndex++}`);
      values.push(lastName);
    }

    if ('age' in body) {
      const age = normalizeOptionalAge(body.age);
      if (age === undefined) return errorResponse('Age must be a whole number', 400);
      fields.push(`age = $${paramIndex++}`);
      values.push(age);
    }

    if ('birthday' in body) {
      const birthday = normalizeOptionalBirthday(body.birthday);
      if (birthday === undefined) {
        return errorResponse('Birthday must be in YYYY-MM-DD format', 400);
      }
      fields.push(`birthday = $${paramIndex++}`);
      values.push(birthday);
    }

    if ('emergency_contact' in body) {
      const emergencyContact = normalizeRequiredText(body.emergency_contact);
      if (!emergencyContact) return errorResponse('Emergency contact is required', 400);
      fields.push(`emergency_contact = $${paramIndex++}`);
      values.push(emergencyContact);
    }

    if ('contact_email' in body) {
      const contactEmail = normalizeRequiredText(body.contact_email);
      if (!contactEmail) return errorResponse('Contact email is required', 400);
      fields.push(`contact_email = $${paramIndex++}`);
      values.push(contactEmail);
    }

    if ('contact_phone' in body) {
      fields.push(`contact_phone = $${paramIndex++}`);
      values.push(normalizeOptionalText(body.contact_phone));
    }

    if ('signup_price' in body) {
      const signupPrice = normalizeOptionalMoney(body.signup_price);
      if (signupPrice === undefined) {
        return errorResponse('Signup price must be a valid non-negative number', 400);
      }
      fields.push(`signup_price = $${paramIndex++}`);
      values.push(signupPrice);
    }

    if ('amount_paid' in body) {
      requestedAmountPaid = normalizeOptionalMoney(body.amount_paid);
      if (requestedAmountPaid === undefined) {
        return errorResponse('Amount paid must be a valid non-negative number', 400);
      }
      fields.push(`amount_paid = $${paramIndex++}`);
      values.push(requestedAmountPaid);
    }

    const optionalTextFields = [
      'foot',
      'team',
      'notes',
      'stripe_payment_intent_id',
      'stripe_checkout_session_id',
      'stripe_charge_id',
      'stripe_receipt_url',
    ] as const;

    for (const field of optionalTextFields) {
      if (field in body) {
        fields.push(`${field} = $${paramIndex++}`);
        values.push(normalizeOptionalText(body[field]));
      }
    }

    if ('has_paid' in body) {
      requestedHasPaid = body.has_paid === true;
      fields.push(`has_paid = $${paramIndex++}`);
      values.push(requestedHasPaid);
    }

    if (fields.length === 0) {
      return errorResponse('No fields to update', 400);
    }

    let existingSignup:
      | {
          group_session_id: number;
          has_paid: boolean;
          max_players: number;
          amount_paid: string | number | null;
        }
      | null = null;

    if (requestedHasPaid !== null || 'amount_paid' in body) {
      const signupResult = await query(
        `SELECT ps.group_session_id, ps.has_paid, ps.amount_paid, gs.max_players
         FROM player_signups ps
         JOIN group_sessions gs ON gs.id = ps.group_session_id
         WHERE ps.id = $1`,
        [id]
      );

      if (signupResult.rows.length === 0) {
        return errorResponse('Player signup not found', 404);
      }

      existingSignup = signupResult.rows[0] as {
        group_session_id: number;
        has_paid: boolean;
        max_players: number;
        amount_paid: string | number | null;
      };
    }

    if (requestedHasPaid === true && existingSignup && !existingSignup.has_paid) {
      const capacityResult = await query(
        `SELECT COUNT(*)::int AS paid_player_count
         FROM player_signups
         WHERE group_session_id = $1
           AND has_paid = true`,
        [existingSignup.group_session_id]
      );

      const paidPlayerCount = Number(capacityResult.rows[0]?.paid_player_count || 0);
      if (paidPlayerCount >= Number(existingSignup.max_players)) {
        return errorResponse('This group session is already full', 400);
      }
    }

    if (existingSignup) {
      const effectiveHasPaid = requestedHasPaid ?? existingSignup.has_paid;
      const effectiveAmountPaid =
        requestedAmountPaid !== undefined
          ? requestedAmountPaid
          : existingSignup.amount_paid == null
            ? null
            : Number(existingSignup.amount_paid);

      if (effectiveHasPaid && effectiveAmountPaid == null) {
        return errorResponse('Amount paid is required when signup is marked paid', 400);
      }
      if (!effectiveHasPaid && requestedAmountPaid != null) {
        return errorResponse('Amount paid can only be set when signup is marked paid', 400);
      }
    }

    if (requestedHasPaid === false && !('amount_paid' in body)) {
      fields.push(`amount_paid = $${paramIndex++}`);
      values.push(null);
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    const result = await query(
      `UPDATE player_signups
       SET ${fields.join(', ')}
       WHERE id = $${paramIndex}
       RETURNING *`,
      values
    );

    if (result.rows.length === 0) {
      return errorResponse('Player signup not found', 404);
    }

    return jsonResponse(result.rows[0]);
  } catch (error) {
    console.error('Error updating player signup:', error);
    return errorResponse('Failed to update player signup');
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await query('DELETE FROM player_signups WHERE id = $1 RETURNING id', [id]);

    if (result.rows.length === 0) {
      return errorResponse('Player signup not found', 404);
    }

    return jsonResponse({ deleted: true });
  } catch (error) {
    console.error('Error deleting player signup:', error);
    return errorResponse('Failed to delete player signup');
  }
}
