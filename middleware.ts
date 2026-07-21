import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME, verifySessionToken } from '@/lib/auth';

/** Reachable without a session — otherwise you could never log in. */
const PUBLIC_PATHS = new Set(['/login', '/api/auth/login', '/api/auth/logout']);

/**
 * These authenticate themselves and are called by machines that will never
 * carry the session cookie:
 *  - /api/cron/*  → Vercel Cron, already gated on x-vercel-cron / CRON_SECRET.
 *                   Gating these too would silently kill reminders and texts.
 *  - /api/health  → uptime checks; returns status only, no CRM data.
 */
const SELF_AUTHENTICATED_PREFIXES = ['/api/cron', '/api/health'];

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (
    PUBLIC_PATHS.has(pathname) ||
    SELF_AUTHENTICATED_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  ) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (await verifySessionToken(token)) {
    return NextResponse.next();
  }

  // API calls get a status code rather than an HTML redirect, so fetches fail
  // loudly instead of silently parsing a login page as JSON.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const loginUrl = new URL('/login', request.url);
  const target = `${pathname}${search}`;
  // Only ever round-trip a same-site path, never an absolute URL (open redirect).
  if (target && target !== '/' && !target.startsWith('//')) {
    loginUrl.searchParams.set('next', target);
  }
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Everything except Next internals and static files.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|icon.png|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp|txt|xml|woff|woff2)$).*)',
  ],
};
