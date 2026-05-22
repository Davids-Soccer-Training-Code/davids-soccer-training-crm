import { NextRequest } from 'next/server';
import { query } from '@/lib/db';
import { jsonResponse, errorResponse } from '@/lib/api-helpers';
import { sendEmail } from '@/lib/email';

export const dynamic = 'force-dynamic';

export interface EmailContact {
  email: string;
  name: string;
  source: 'crm' | 'app' | 'signup';
  is_dead: boolean;
}

export async function GET() {
  try {
    // Pull from all three sources, dedup by lowercase email (crm takes priority, then app, then signup)
    const result = await query(`
      WITH crm AS (
        SELECT
          LOWER(TRIM(email)) AS email_key,
          TRIM(email) AS email,
          name,
          COALESCE(is_dead, false) AS is_dead,
          'crm' AS source,
          1 AS priority
        FROM crm_parents
        WHERE email IS NOT NULL AND TRIM(email) <> ''
      ),
      app_rows AS (
        SELECT
          LOWER(TRIM(p.email)) AS email_key,
          TRIM(p.email) AS email,
          COALESCE(p.name, TRIM(p.email)) AS name,
          false AS is_dead,
          'app' AS source,
          2 AS priority
        FROM parents p
        WHERE p.email IS NOT NULL AND TRIM(p.email) <> ''
      ),
      signup_rows AS (
        SELECT
          LOWER(TRIM(contact_email)) AS email_key,
          TRIM(contact_email) AS email,
          TRIM(first_name || ' ' || last_name) AS name,
          false AS is_dead,
          'signup' AS source,
          3 AS priority
        FROM player_signups
        WHERE contact_email IS NOT NULL AND TRIM(contact_email) <> ''
      ),
      all_rows AS (
        SELECT * FROM crm
        UNION ALL
        SELECT * FROM app_rows
        UNION ALL
        SELECT * FROM signup_rows
      ),
      deduped AS (
        SELECT DISTINCT ON (email_key)
          email, name, is_dead, source
        FROM all_rows
        ORDER BY email_key, priority ASC
      )
      SELECT email, name, is_dead, source
      FROM deduped
      ORDER BY name ASC
    `);
    return jsonResponse(result.rows as EmailContact[]);
  } catch (error) {
    console.error('Error fetching contacts for email blast:', error);
    return errorResponse('Failed to fetch contacts');
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { emails, subject, html } = body as {
      emails: string[];
      subject: string;
      html: string;
    };

    if (!Array.isArray(emails) || emails.length === 0) {
      return errorResponse('At least one email address must be provided', 400);
    }
    if (!subject || typeof subject !== 'string' || !subject.trim()) {
      return errorResponse('Subject is required', 400);
    }
    if (!html || typeof html !== 'string' || !html.trim()) {
      return errorResponse('Email body is required', 400);
    }

    const validEmails = emails
      .map((e) => (typeof e === 'string' ? e.trim() : ''))
      .filter((e) => e.includes('@'));

    if (validEmails.length === 0) {
      return errorResponse('No valid email addresses provided', 400);
    }

    const sent: string[] = [];
    const failed: { email: string; error: string }[] = [];

    for (const email of validEmails) {
      try {
        await sendEmail({ to: email, subject: subject.trim(), html: html.trim() });
        sent.push(email);
      } catch (err) {
        console.error(`Failed to send to ${email}:`, err);
        failed.push({ email, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }

    return jsonResponse({ sent_count: sent.length, failed_count: failed.length, sent, failed });
  } catch (error) {
    console.error('Error sending email blast:', error);
    return errorResponse('Failed to send emails');
  }
}
