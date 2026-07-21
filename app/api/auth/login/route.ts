import { NextRequest, NextResponse } from 'next/server';
import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
  createSessionToken,
  isPasswordConfigured,
  passwordMatches,
} from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  if (!isPasswordConfigured()) {
    return NextResponse.json(
      { error: 'CRM_PASSWORD is not configured on the server.' },
      { status: 500 }
    );
  }

  let password = '';
  try {
    const body = await request.json();
    password = typeof body?.password === 'string' ? body.password : '';
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  if (!(await passwordMatches(password))) {
    return NextResponse.json({ error: 'Incorrect password' }, { status: 401 });
  }

  const token = await createSessionToken();
  if (!token) {
    return NextResponse.json({ error: 'Could not create session' }, { status: 500 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return response;
}
