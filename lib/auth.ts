/**
 * Single-password gate for the whole CRM.
 *
 * The session cookie is an HMAC-signed expiry stamp, keyed by CRM_PASSWORD
 * itself, so there's only one env var to manage and changing the password
 * immediately invalidates every existing session.
 *
 * Everything here uses Web Crypto (not node:crypto) because middleware runs on
 * the Edge runtime.
 */

export const SESSION_COOKIE_NAME = 'crm_session';
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

const encoder = new TextEncoder();

/** The configured password, or null when the env var is missing/empty. */
export function getConfiguredPassword(): string | null {
  const password = process.env.CRM_PASSWORD;
  return password && password.length > 0 ? password : null;
}

export function isPasswordConfigured(): boolean {
  return getConfiguredPassword() !== null;
}

function toBase64Url(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Constant-time comparison of two equal-length strings. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function sha256(value: string): Promise<string> {
  return toBase64Url(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function signPayload(payload: string, password: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return toBase64Url(await crypto.subtle.sign('HMAC', key, encoder.encode(payload)));
}

/**
 * Compare a submitted password against CRM_PASSWORD. Both sides are hashed
 * first so the comparison doesn't leak the configured password's length.
 */
export async function passwordMatches(input: string): Promise<boolean> {
  const password = getConfiguredPassword();
  if (!password || typeof input !== 'string' || input.length === 0) return false;
  const [inputHash, expectedHash] = await Promise.all([sha256(input), sha256(password)]);
  return timingSafeEqual(inputHash, expectedHash);
}

/** Mint a signed token that expires SESSION_MAX_AGE_SECONDS from now. */
export async function createSessionToken(): Promise<string | null> {
  const password = getConfiguredPassword();
  if (!password) return null;
  const expiresAt = String(Date.now() + SESSION_MAX_AGE_SECONDS * 1000);
  return `${expiresAt}.${await signPayload(expiresAt, password)}`;
}

/** True only for an unexpired token whose signature matches CRM_PASSWORD. */
export async function verifySessionToken(token: string | null | undefined): Promise<boolean> {
  const password = getConfiguredPassword();
  if (!password || !token) return false;

  const separator = token.lastIndexOf('.');
  if (separator <= 0) return false;

  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);

  const expiresAt = Number(payload);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;

  return timingSafeEqual(signature, await signPayload(payload, password));
}
