import { JWT, OAuth2Client } from 'google-auth-library';
import { query } from '@/lib/db';
import { ensureFirstSessionCalendarColumns } from '@/lib/first-session-calendar-fields';
import { ensureSessionCalendarColumns, parseGuestEmails } from '@/lib/session-calendar-fields';
import type { SessionExtra } from '@/lib/session-extras';
import { formatExtrasForDescription } from '@/lib/session-extras';
import { ensureGroupSessionCoachTables } from '@/lib/group-session-coaches';

const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
const GOOGLE_CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
const ARIZONA_TIMEZONE = 'America/Phoenix';
const GOOGLE_EVENT_SUMMARY_MAX = 1024;
const GOOGLE_EVENT_LOCATION_MAX = 1024;
const GOOGLE_EVENT_DESCRIPTION_MAX = 8192;
const DEFAULT_GROUP_CALENDAR_ID =
  '8b987ac6ab05468d001f9856f8a62b4f58634a27a3d6570142380551cfed3125@group.calendar.google.com';

let jwtClient: JWT | null = null;
let oauthClient: OAuth2Client | null = null;
let ensureTablePromise: Promise<void> | null = null;
let hasLoggedMissingConfig = false;
let hasLoggedOauthFallback = false;
let forceServiceAccountFallback = false;

type GoogleAuthConfig =
  | {
      kind: 'oauth_user';
      clientId: string;
      clientSecret: string;
      refreshToken: string;
      redirectUri: string;
    }
  | {
      kind: 'service_account';
      clientEmail: string;
      privateKey: string;
    };

interface GoogleCalendarConfig {
  privateCalendarId: string;
  packageCalendarId: string;
  groupCalendarId: string;
  managedCalendarIds: string[];
  auth: GoogleAuthConfig;
}

interface SessionSyncRow {
  id: number;
  session_date: string | Date;
  start_arizona_local: string;
  end_arizona_local: string;
  title: string | null;
  location: string | null;
  notes: string | null;
  status: string | null;
  cancelled: boolean | null;
  package_id: number | null;
  guest_emails: string[] | null;
  send_email_updates: boolean | null;
  parent_name: string;
  coach_name: string | null;
  player_names: string[];
  /** Other families' players riding along on this session. */
  extras: SessionExtra[];
}

interface FirstSessionSyncRow {
  id: number;
  session_date: string | Date;
  start_arizona_local: string;
  end_arizona_local: string;
  title: string | null;
  location: string | null;
  notes: string | null;
  status: string | null;
  cancelled: boolean | null;
  parent_name: string;
  parent_email: string | null;
  coach_name: string | null;
  guest_emails: string[] | null;
  send_email_updates: boolean | null;
  player_names: string[];
  /** Other families' players riding along on this session. */
  extras: SessionExtra[];
}

interface GroupSessionSyncRow {
  id: number;
  session_date: string | Date;
  start_arizona_local: string;
  end_arizona_local: string;
  title: string;
  description: string | null;
  location: string | null;
  price: string | number | null;
  curriculum: string | null;
  max_players: number;
  player_count: number;
  prospect_count: number;
  /** Signed-up families' contact emails, for the event's guest list. */
  attendee_emails: string[] | null;
  coach_names: string[] | null;
  /** Assigned coaches go on the guest list too, so it lands on their calendar. */
  coach_emails: string[] | null;
}

interface GoogleSessionEventMapping {
  calendar_id: string;
  google_event_id: string;
}

interface GoogleCalendarEventResponse {
  id?: string;
  status?: string;
}

interface GoogleCalendarEventListResponse {
  items?: Array<{
    id?: string;
    status?: string;
  }>;
  nextPageToken?: string;
}

class GoogleCalendarApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GoogleCalendarApiError';
    this.status = status;
  }
}

type GoogleSendUpdatesMode = 'all' | 'none';

interface GoogleSyncOptions {
  sendUpdates?: GoogleSendUpdatesMode;
}

interface AccessTokenOptions {
  disallowOauthFallback?: boolean;
}

function parseCalendarIdList(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function getGoogleCalendarConfig(): GoogleCalendarConfig | null {
  const listIds = parseCalendarIdList(process.env.GOOGLE_CALENDAR_IDS);
  const fallbackSingleId = (process.env.GOOGLE_CALENDAR_ID || '').trim();

  const privateCalendarId =
    (process.env.GOOGLE_PRIVATE_CALENDAR_ID || '').trim() ||
    listIds[0] ||
    fallbackSingleId;

  const packageCalendarId =
    (process.env.GOOGLE_PACKAGE_CALENDAR_ID || '').trim() ||
    listIds[1] ||
    privateCalendarId ||
    fallbackSingleId;
  const groupCalendarId =
    (process.env.GOOGLE_GROUP_CALENDAR_ID || '').trim() || DEFAULT_GROUP_CALENDAR_ID;

  if (!privateCalendarId) {
    return null;
  }

  const managedCalendarIds = [
    ...new Set([privateCalendarId, packageCalendarId, groupCalendarId].filter(Boolean)),
  ];

  const oauthClientId = (process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
  const oauthClientSecret = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
  const oauthRefreshToken = (process.env.GOOGLE_OAUTH_REFRESH_TOKEN || '').trim();
  const oauthRedirectUri =
    (process.env.GOOGLE_OAUTH_REDIRECT_URI || '').trim() || 'http://localhost:5055/oauth2callback';

  const serviceClientEmail = (process.env.GOOGLE_CLIENT_EMAIL || '').trim();
  const servicePrivateKeyRaw = process.env.GOOGLE_PRIVATE_KEY || '';

  let auth: GoogleAuthConfig | null = null;

  if (oauthClientId && oauthClientSecret && oauthRefreshToken) {
    auth = {
      kind: 'oauth_user',
      clientId: oauthClientId,
      clientSecret: oauthClientSecret,
      refreshToken: oauthRefreshToken,
      redirectUri: oauthRedirectUri,
    };
  } else if (serviceClientEmail && servicePrivateKeyRaw) {
    auth = {
      kind: 'service_account',
      clientEmail: serviceClientEmail,
      privateKey: servicePrivateKeyRaw.replace(/\\n/g, '\n'),
    };
  }

  if (!auth) {
    return null;
  }

  return {
    privateCalendarId,
    packageCalendarId,
    groupCalendarId,
    managedCalendarIds,
    auth,
  };
}

function getServiceAccountAuthFromEnv(): Extract<GoogleAuthConfig, { kind: 'service_account' }> | null {
  const serviceClientEmail = (process.env.GOOGLE_CLIENT_EMAIL || '').trim();
  const servicePrivateKeyRaw = process.env.GOOGLE_PRIVATE_KEY || '';
  if (!serviceClientEmail || !servicePrivateKeyRaw) return null;
  return {
    kind: 'service_account',
    clientEmail: serviceClientEmail,
    privateKey: servicePrivateKeyRaw.replace(/\\n/g, '\n'),
  };
}

function isInvalidGrantError(error: unknown): boolean {
  if (!error) return false;
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error);
  return message.toLowerCase().includes('invalid_grant');
}

function logMissingConfigOnce(): void {
  if (hasLoggedMissingConfig) return;

  console.log(
    'Google Calendar sync disabled: set GOOGLE_PRIVATE_CALENDAR_ID/GOOGLE_PACKAGE_CALENDAR_ID plus auth (preferred OAuth: GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN; fallback service account: GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY).'
  );
  hasLoggedMissingConfig = true;
}

function getJwtClient(auth: Extract<GoogleAuthConfig, { kind: 'service_account' }>): JWT {
  if (!jwtClient) {
    jwtClient = new JWT({
      email: auth.clientEmail,
      key: auth.privateKey,
      scopes: [GOOGLE_CALENDAR_SCOPE],
    });
  }
  return jwtClient;
}

function getOauthClient(auth: Extract<GoogleAuthConfig, { kind: 'oauth_user' }>): OAuth2Client {
  if (!oauthClient) {
    oauthClient = new OAuth2Client({
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      redirectUri: auth.redirectUri,
    });
  }
  oauthClient.setCredentials({ refresh_token: auth.refreshToken });
  return oauthClient;
}

async function getAccessToken(
  config: GoogleCalendarConfig,
  options: AccessTokenOptions = {}
): Promise<string> {
  let tokenResponse: string | { token?: string | null } | null;
  const disallowOauthFallback = options.disallowOauthFallback === true;

  if (config.auth.kind === 'oauth_user' && !forceServiceAccountFallback) {
    try {
      tokenResponse = await getOauthClient(config.auth).getAccessToken();
    } catch (error) {
      if (!isInvalidGrantError(error)) throw error;
      if (disallowOauthFallback) {
        throw new Error(
          'Google OAuth refresh token is invalid. Guest email updates require OAuth. Renew GOOGLE_OAUTH_REFRESH_TOKEN.'
        );
      }

      const serviceFallback = getServiceAccountAuthFromEnv();
      if (!serviceFallback) throw error;
      forceServiceAccountFallback = true;

      if (!hasLoggedOauthFallback) {
        console.warn(
          'Google OAuth refresh token returned invalid_grant; falling back to service account credentials.'
        );
        hasLoggedOauthFallback = true;
      }
      tokenResponse = await getJwtClient(serviceFallback).getAccessToken();
    }
  } else {
    if (config.auth.kind === 'service_account') {
      tokenResponse = await getJwtClient(config.auth).getAccessToken();
    } else {
      const serviceFallback = getServiceAccountAuthFromEnv();
      if (!serviceFallback) {
        throw new Error(
          'OAuth refresh token is invalid and no service account fallback is configured.'
        );
      }
      tokenResponse = await getJwtClient(serviceFallback).getAccessToken();
    }
  }

  const token =
    typeof tokenResponse === 'string' ? tokenResponse : tokenResponse?.token || null;

  if (!token) {
    throw new Error('Failed to obtain Google Calendar access token.');
  }

  return token;
}

async function ensureGoogleEventsTable(): Promise<void> {
  if (ensureTablePromise) {
    await ensureTablePromise;
    return;
  }

  ensureTablePromise = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS crm_session_google_events (
        id BIGSERIAL PRIMARY KEY,
        session_id BIGINT NOT NULL REFERENCES crm_sessions(id) ON DELETE CASCADE,
        calendar_id TEXT NOT NULL,
        google_event_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(session_id, calendar_id)
      )
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_crm_session_google_events_session_id
      ON crm_session_google_events(session_id)
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS crm_first_session_google_events (
        id BIGSERIAL PRIMARY KEY,
        first_session_id BIGINT NOT NULL REFERENCES crm_first_sessions(id) ON DELETE CASCADE,
        calendar_id TEXT NOT NULL,
        google_event_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(first_session_id, calendar_id)
      )
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_crm_first_session_google_events_first_session_id
      ON crm_first_session_google_events(first_session_id)
    `);

    await query(`
      CREATE TABLE IF NOT EXISTS crm_group_session_google_events (
        id BIGSERIAL PRIMARY KEY,
        group_session_id BIGINT NOT NULL REFERENCES group_sessions(id) ON DELETE CASCADE,
        calendar_id TEXT NOT NULL,
        google_event_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(group_session_id, calendar_id)
      )
    `);

    await query(`
      CREATE INDEX IF NOT EXISTS idx_crm_group_session_google_events_group_session_id
      ON crm_group_session_google_events(group_session_id)
    `);
  })().catch((error) => {
    ensureTablePromise = null;
    throw error;
  });

  await ensureTablePromise;
}

async function getSessionForSync(sessionId: string | number): Promise<SessionSyncRow | null> {
  const result = await query(
    `SELECT
       s.id,
       s.session_date,
       to_char((((s.session_date AT TIME ZONE 'UTC') AT TIME ZONE 'America/Phoenix')), 'YYYY-MM-DD\"T\"HH24:MI:SS') AS start_arizona_local,
       to_char((((COALESCE(s.session_end_date, s.session_date + interval '60 minutes') AT TIME ZONE 'UTC') AT TIME ZONE 'America/Phoenix')), 'YYYY-MM-DD\"T\"HH24:MI:SS') AS end_arizona_local,
       s.title,
       s.location,
       s.notes,
       s.status,
       s.cancelled,
       s.package_id,
       s.guest_emails,
       s.send_email_updates,
       p.name AS parent_name,
       st.name AS coach_name,
       COALESCE((
         SELECT json_agg(json_build_object(
                  'player_id', xpl.id,
                  'player_name', xpl.name,
                  'player_age', xpl.age,
                  'player_team', xpl.team,
                  'parent_id', xpar.id,
                  'parent_name', xpar.name,
                  'parent_email', xpar.email,
                  'parent_phone', xpar.phone,
                  'secondary_parent_name', xpar.secondary_parent_name,
                  'notes', x.notes
                ) ORDER BY xpar.name, xpl.name)
         FROM crm_session_extras x
         JOIN crm_players xpl ON xpl.id = x.player_id
         JOIN crm_parents xpar ON xpar.id = xpl.parent_id
         WHERE x.session_id = s.id
       ), '[]'::json) AS extras,
       COALESCE(ARRAY_AGG(pl.name) FILTER (WHERE pl.name IS NOT NULL), '{}') AS player_names
     FROM crm_sessions s
     JOIN crm_parents p ON p.id = s.parent_id
     LEFT JOIN crm_staff st ON st.id = s.coach_id
     LEFT JOIN crm_session_players sp ON sp.session_id = s.id
     LEFT JOIN crm_players pl ON pl.id = sp.player_id
     WHERE s.id = $1
     GROUP BY s.id, p.name, st.name`,
    [sessionId]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0] as SessionSyncRow;
  row.player_names = Array.isArray(row.player_names) ? row.player_names.filter(Boolean) : [];
  row.guest_emails = Array.isArray(row.guest_emails) ? row.guest_emails : [];
  row.extras = Array.isArray(row.extras) ? row.extras : [];
  return row;
}

async function getFirstSessionForSync(
  firstSessionId: string | number
): Promise<FirstSessionSyncRow | null> {
  const result = await query(
    `SELECT
       fs.id,
       fs.session_date,
       to_char((((fs.session_date AT TIME ZONE 'UTC') AT TIME ZONE 'America/Phoenix')), 'YYYY-MM-DD\"T\"HH24:MI:SS') AS start_arizona_local,
       to_char((((COALESCE(fs.session_end_date, fs.session_date + interval '60 minutes') AT TIME ZONE 'UTC') AT TIME ZONE 'America/Phoenix')), 'YYYY-MM-DD\"T\"HH24:MI:SS') AS end_arizona_local,
       fs.title,
       fs.location,
       fs.notes,
       fs.status,
       fs.cancelled,
       p.name AS parent_name,
       p.email AS parent_email,
       st.name AS coach_name,
       fs.guest_emails,
       fs.send_email_updates,
       COALESCE((
         SELECT json_agg(json_build_object(
                  'player_id', xpl.id,
                  'player_name', xpl.name,
                  'player_age', xpl.age,
                  'player_team', xpl.team,
                  'parent_id', xpar.id,
                  'parent_name', xpar.name,
                  'parent_email', xpar.email,
                  'parent_phone', xpar.phone,
                  'secondary_parent_name', xpar.secondary_parent_name,
                  'notes', x.notes
                ) ORDER BY xpar.name, xpl.name)
         FROM crm_first_session_extras x
         JOIN crm_players xpl ON xpl.id = x.player_id
         JOIN crm_parents xpar ON xpar.id = xpl.parent_id
         WHERE x.first_session_id = fs.id
       ), '[]'::json) AS extras,
       COALESCE(ARRAY_AGG(pl.name) FILTER (WHERE pl.name IS NOT NULL), '{}') AS player_names
     FROM crm_first_sessions fs
     JOIN crm_parents p ON p.id = fs.parent_id
     LEFT JOIN crm_staff st ON st.id = fs.coach_id
     LEFT JOIN crm_first_session_players fsp ON fsp.first_session_id = fs.id
     LEFT JOIN crm_players pl ON pl.id = fsp.player_id
     WHERE fs.id = $1
     GROUP BY fs.id, p.name, p.email, st.name`,
    [firstSessionId]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0] as FirstSessionSyncRow;
  row.player_names = Array.isArray(row.player_names) ? row.player_names.filter(Boolean) : [];
  row.guest_emails = Array.isArray(row.guest_emails) ? row.guest_emails : [];
  row.extras = Array.isArray(row.extras) ? row.extras : [];
  return row;
}

async function getGroupSessionForSync(
  groupSessionId: string | number
): Promise<GroupSessionSyncRow | null> {
  await ensureGroupSessionCoachTables();
  const result = await query(
    `SELECT
       gs.id,
       gs.session_date,
       -- NOTE: only ONE conversion here, unlike the private/first-session
       -- queries above. Their session_date is a naive timestamp holding UTC
       -- wall clock, so those must go through UTC first to become an instant.
       -- group_sessions.session_date is a timestamptz and already IS an
       -- instant -- sending it through UTC first re-reads the UTC wall clock
       -- as Phoenix local and pushes the event 7 hours late.
       to_char((gs.session_date AT TIME ZONE 'America/Phoenix'), 'YYYY-MM-DD"T"HH24:MI:SS') AS start_arizona_local,
       to_char((COALESCE(gs.session_date_end, gs.session_date + interval '60 minutes') AT TIME ZONE 'America/Phoenix'), 'YYYY-MM-DD"T"HH24:MI:SS') AS end_arizona_local,
       gs.title,
       gs.description,
       gs.location,
       gs.price,
       gs.curriculum,
       gs.max_players,
       COUNT(ps.id) FILTER (WHERE ps.has_paid = true)::int AS player_count,
       COUNT(ps.id) FILTER (WHERE COALESCE(ps.has_paid, false) = false)::int AS prospect_count,
       COALESCE(
         ARRAY_AGG(DISTINCT ps.contact_email)
           FILTER (WHERE ps.contact_email IS NOT NULL AND ps.contact_email <> ''),
         '{}'
       ) AS attendee_emails,
       (SELECT ARRAY_AGG(st.name ORDER BY st.name)
          FROM group_session_coaches gsc JOIN crm_staff st ON st.id = gsc.staff_id
          WHERE gsc.group_session_id = gs.id) AS coach_names,
       (SELECT ARRAY_AGG(st.email)
          FROM group_session_coaches gsc JOIN crm_staff st ON st.id = gsc.staff_id
          WHERE gsc.group_session_id = gs.id AND st.email IS NOT NULL AND st.email <> '') AS coach_emails
     FROM group_sessions gs
     LEFT JOIN player_signups ps ON ps.group_session_id = gs.id
     WHERE gs.id = $1
     GROUP BY gs.id`,
    [groupSessionId]
  );

  if (result.rows.length === 0) return null;
  const row = result.rows[0] as GroupSessionSyncRow;
  row.attendee_emails = Array.isArray(row.attendee_emails) ? row.attendee_emails : [];
  row.coach_names = Array.isArray(row.coach_names) ? row.coach_names : [];
  row.coach_emails = Array.isArray(row.coach_emails) ? row.coach_emails : [];
  return row;
}

function shouldDeleteCalendarEvents(session: SessionSyncRow): boolean {
  const status = (session.status || '').toLowerCase();
  return session.cancelled === true || status === 'cancelled' || status === 'no_show';
}

function shouldDeleteFirstSessionCalendarEvents(firstSession: FirstSessionSyncRow): boolean {
  const status = (firstSession.status || '').toLowerCase();
  return firstSession.cancelled === true || status === 'cancelled' || status === 'no_show';
}

function getTargetCalendarId(session: SessionSyncRow, config: GoogleCalendarConfig): string {
  return session.package_id ? config.packageCalendarId : config.privateCalendarId;
}

function appendCoachToSummary(summary: string, coachName: string | null | undefined): string {
  const coach = coachName?.trim();
  if (!coach) return summary;

  const suffix = `with Coach ${coach}`;
  // Avoid double-appending when re-syncing an event that already carries the suffix.
  if (summary.toLowerCase().endsWith(suffix.toLowerCase())) return summary;

  return `${summary} ${suffix}`;
}

function truncateGoogleField(value: string | null | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length <= maxLength) return normalized;

  const suffix = ' ... [truncated]';
  if (maxLength <= suffix.length) return normalized.slice(0, maxLength);
  return `${normalized.slice(0, maxLength - suffix.length)}${suffix}`;
}

function buildGoogleEventPayload(session: SessionSyncRow): Record<string, unknown> {
  if (!session.start_arizona_local || !session.end_arizona_local) {
    throw new Error(`Missing Arizona-local datetime fields for session ${session.id}`);
  }
  const sessionType = session.package_id ? 'Package Session' : 'Private Session';

  const details: string[] = [
    `Type: ${sessionType}`,
    `Parent: ${session.parent_name}`,
    `Session ID: ${session.id}`,
  ];
  if (session.player_names.length > 0) {
    details.push(`Players: ${session.player_names.join(', ')}`);
  }
  if (session.extras.length > 0) {
    details.push(`Extras: ${formatExtrasForDescription(session.extras).join('; ')}`);
  }
  if (session.notes && session.notes.trim()) {
    details.push(`Notes: ${session.notes.trim()}`);
  }

  // Extra parents are merged in here rather than stored on `guest_emails` so
  // that removing an extra also drops them from the invite, and so a hand-edited
  // guest list never has to account for them.
  const attendeeEmails = parseGuestEmails([
    ...(session.guest_emails || []),
    ...session.extras.map((extra) => extra.parent_email || ''),
  ]).emails;
  const baseSummary = session.title?.trim()
    ? session.title.trim()
    : `${sessionType}: ${session.parent_name}`;
  const rawSummary = appendCoachToSummary(baseSummary, session.coach_name);
  const summary =
    truncateGoogleField(rawSummary, GOOGLE_EVENT_SUMMARY_MAX) || `${sessionType}: ${session.parent_name}`;
  const description = truncateGoogleField(details.join('\n'), GOOGLE_EVENT_DESCRIPTION_MAX);
  const location = truncateGoogleField(session.location, GOOGLE_EVENT_LOCATION_MAX);

  return {
    summary,
    description,
    location,
    start: {
      dateTime: session.start_arizona_local,
      timeZone: ARIZONA_TIMEZONE,
    },
    end: {
      dateTime: session.end_arizona_local,
      timeZone: ARIZONA_TIMEZONE,
    },
    attendees: attendeeEmails.length > 0 ? attendeeEmails.map((email) => ({ email })) : undefined,
  };
}

function buildFirstSessionGoogleEventPayload(firstSession: FirstSessionSyncRow): Record<string, unknown> {
  if (!firstSession.start_arizona_local || !firstSession.end_arizona_local) {
    throw new Error(`Missing Arizona-local datetime fields for first session ${firstSession.id}`);
  }

  const details: string[] = [
    'Type: First Session',
    `Parent: ${firstSession.parent_name}`,
    `First Session ID: ${firstSession.id}`,
  ];
  if (firstSession.player_names.length > 0) {
    details.push(`Players: ${firstSession.player_names.join(', ')}`);
  }
  if (firstSession.extras.length > 0) {
    details.push(`Extras: ${formatExtrasForDescription(firstSession.extras).join('; ')}`);
  }
  if (firstSession.notes && firstSession.notes.trim()) {
    details.push(`Notes: ${firstSession.notes.trim()}`);
  }

  const attendeeCandidates = [
    ...(Array.isArray(firstSession.guest_emails) ? firstSession.guest_emails : []),
    ...(firstSession.parent_email ? [firstSession.parent_email] : []),
    ...firstSession.extras.map((extra) => extra.parent_email || ''),
  ];
  const attendeeEmails = parseGuestEmails(attendeeCandidates).emails;
  const baseSummary = firstSession.title?.trim()
    ? firstSession.title.trim()
    : `First Session: ${firstSession.parent_name}`;
  const rawSummary = appendCoachToSummary(baseSummary, firstSession.coach_name);
  const summary =
    truncateGoogleField(rawSummary, GOOGLE_EVENT_SUMMARY_MAX) ||
    `First Session: ${firstSession.parent_name}`;
  const description = truncateGoogleField(details.join('\n'), GOOGLE_EVENT_DESCRIPTION_MAX);
  const location = truncateGoogleField(firstSession.location, GOOGLE_EVENT_LOCATION_MAX);

  return {
    summary,
    description,
    location,
    start: {
      dateTime: firstSession.start_arizona_local,
      timeZone: ARIZONA_TIMEZONE,
    },
    end: {
      dateTime: firstSession.end_arizona_local,
      timeZone: ARIZONA_TIMEZONE,
    },
    attendees: attendeeEmails.length > 0 ? attendeeEmails.map((email) => ({ email })) : undefined,
  };
}

function buildGroupSessionGoogleEventPayload(groupSession: GroupSessionSyncRow): Record<string, unknown> {
  if (!groupSession.start_arizona_local || !groupSession.end_arizona_local) {
    throw new Error(`Missing Arizona-local datetime fields for group session ${groupSession.id}`);
  }

  const details: string[] = [
    'Type: Group Session',
    `Group Session ID: ${groupSession.id}`,
    `Max Players: ${groupSession.max_players}`,
    `Paid Signups: ${Number(groupSession.player_count ?? 0)}`,
    `Prospects: ${Number(groupSession.prospect_count ?? 0)}`,
  ];

  if (groupSession.coach_names && groupSession.coach_names.length > 0) {
    details.push(`Coaches: ${groupSession.coach_names.join(', ')}`);
  }

  if (groupSession.curriculum && groupSession.curriculum.trim()) {
    details.push(`Curriculum: ${groupSession.curriculum.trim()}`);
  }
  if (groupSession.price != null && String(groupSession.price).trim() !== '') {
    details.push(`Price: $${Number(groupSession.price).toFixed(2)}`);
  }
  if (groupSession.description && groupSession.description.trim()) {
    details.push(`Description: ${groupSession.description.trim()}`);
  }

  // Guests are added with sendUpdates='none' throughout (see
  // syncGroupSessionEventOnCalendar). The event still lands on their calendar,
  // but Google does not email the families already on it every time a new one
  // is added -- their own signup email carries the invite instead.
  const attendeeEmails = parseGuestEmails([
    ...(groupSession.coach_emails || []),
    ...(groupSession.attendee_emails || []),
  ]).emails;

  return {
    summary:
      truncateGoogleField(groupSession.title, GOOGLE_EVENT_SUMMARY_MAX) ||
      `Group Session ${groupSession.id}`,
    attendees: attendeeEmails.length > 0 ? attendeeEmails.map((email) => ({ email })) : undefined,
    description: truncateGoogleField(details.join('\n'), GOOGLE_EVENT_DESCRIPTION_MAX),
    location: truncateGoogleField(groupSession.location, GOOGLE_EVENT_LOCATION_MAX),
    start: {
      dateTime: groupSession.start_arizona_local,
      timeZone: ARIZONA_TIMEZONE,
    },
    end: {
      dateTime: groupSession.end_arizona_local,
      timeZone: ARIZONA_TIMEZONE,
    },
  };
}

async function googleCalendarRequest<T>(
  config: GoogleCalendarConfig,
  method: string,
  path: string,
  body?: unknown,
  accessTokenOptions: AccessTokenOptions = {}
): Promise<T> {
  const token = await getAccessToken(config, accessTokenOptions);
  const response = await fetch(`${GOOGLE_CALENDAR_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });

  const rawText = await response.text();
  let payload: unknown = null;

  if (rawText) {
    try {
      payload = JSON.parse(rawText);
    } catch {
      payload = rawText;
    }
  }

  if (!response.ok) {
    const apiMessage =
      typeof payload === 'object' &&
      payload !== null &&
      'error' in payload &&
      typeof (payload as { error?: { message?: string } }).error?.message === 'string'
        ? (payload as { error: { message: string } }).error.message
        : rawText.slice(0, 300);

    throw new GoogleCalendarApiError(
      response.status,
      `Google Calendar API ${method} ${path} failed (${response.status}): ${apiMessage}`
    );
  }

  return payload as T;
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof GoogleCalendarApiError && error.status === 404;
}

function isAttendeePermissionError(error: unknown): boolean {
  if (!(error instanceof GoogleCalendarApiError)) return false;
  const message = error.message.toLowerCase();
  return (
    error.status === 403 &&
    (message.includes('cannot invite attendees') ||
      message.includes('domain-wide delegation') ||
      message.includes('forbidden for this calendar'))
  );
}

function withoutAttendees(payload: Record<string, unknown>): Record<string, unknown> {
  const clone = { ...payload };
  delete clone.attendees;
  return clone;
}

function withSendUpdates(path: string, sendUpdates: GoogleSendUpdatesMode): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}sendUpdates=${sendUpdates}`;
}

function getSessionSendUpdatesMode(
  session: Pick<SessionSyncRow, 'send_email_updates'>,
  requested?: GoogleSendUpdatesMode
): GoogleSendUpdatesMode {
  if (requested) return requested;
  return session.send_email_updates ? 'all' : 'none';
}

function getFirstSessionSendUpdatesMode(
  firstSession: Pick<FirstSessionSyncRow, 'send_email_updates'>,
  requested?: GoogleSendUpdatesMode
): GoogleSendUpdatesMode {
  if (requested) return requested;
  return firstSession.send_email_updates ? 'all' : 'none';
}

async function getStoredSessionSendUpdatesMode(
  sessionId: string | number,
  requested?: GoogleSendUpdatesMode
): Promise<GoogleSendUpdatesMode> {
  if (requested) return requested;

  const result = await query(
    `SELECT send_email_updates
     FROM crm_sessions
     WHERE id = $1
     LIMIT 1`,
    [sessionId]
  );
  const row = result.rows[0] as { send_email_updates?: boolean } | undefined;
  return row?.send_email_updates ? 'all' : 'none';
}

async function getStoredFirstSessionSendUpdatesMode(
  firstSessionId: string | number,
  requested?: GoogleSendUpdatesMode
): Promise<GoogleSendUpdatesMode> {
  if (requested) return requested;

  const result = await query(
    `SELECT send_email_updates
     FROM crm_first_sessions
     WHERE id = $1
     LIMIT 1`,
    [firstSessionId]
  );
  const row = result.rows[0] as { send_email_updates?: boolean } | undefined;
  return row?.send_email_updates ? 'all' : 'none';
}

async function getSessionMappings(sessionId: string | number): Promise<GoogleSessionEventMapping[]> {
  const result = await query(
    `SELECT calendar_id, google_event_id
     FROM crm_session_google_events
     WHERE session_id = $1`,
    [sessionId]
  );

  return result.rows as GoogleSessionEventMapping[];
}

async function getFirstSessionMappings(
  firstSessionId: string | number
): Promise<GoogleSessionEventMapping[]> {
  const result = await query(
    `SELECT calendar_id, google_event_id
     FROM crm_first_session_google_events
     WHERE first_session_id = $1`,
    [firstSessionId]
  );

  return result.rows as GoogleSessionEventMapping[];
}

async function getSessionMapping(
  sessionId: string | number,
  calendarId: string
): Promise<GoogleSessionEventMapping | null> {
  const result = await query(
    `SELECT calendar_id, google_event_id
     FROM crm_session_google_events
     WHERE session_id = $1 AND calendar_id = $2
     LIMIT 1`,
    [sessionId, calendarId]
  );

  if (result.rows.length === 0) return null;
  return result.rows[0] as GoogleSessionEventMapping;
}

async function getFirstSessionMapping(
  firstSessionId: string | number,
  calendarId: string
): Promise<GoogleSessionEventMapping | null> {
  const result = await query(
    `SELECT calendar_id, google_event_id
     FROM crm_first_session_google_events
     WHERE first_session_id = $1 AND calendar_id = $2
     LIMIT 1`,
    [firstSessionId, calendarId]
  );

  if (result.rows.length === 0) return null;
  return result.rows[0] as GoogleSessionEventMapping;
}

async function getGroupSessionMappings(
  groupSessionId: string | number
): Promise<GoogleSessionEventMapping[]> {
  const result = await query(
    `SELECT calendar_id, google_event_id
     FROM crm_group_session_google_events
     WHERE group_session_id = $1`,
    [groupSessionId]
  );

  return result.rows as GoogleSessionEventMapping[];
}

async function getGroupSessionMapping(
  groupSessionId: string | number,
  calendarId: string
): Promise<GoogleSessionEventMapping | null> {
  const result = await query(
    `SELECT calendar_id, google_event_id
     FROM crm_group_session_google_events
     WHERE group_session_id = $1 AND calendar_id = $2
     LIMIT 1`,
    [groupSessionId, calendarId]
  );

  if (result.rows.length === 0) return null;
  return result.rows[0] as GoogleSessionEventMapping;
}

async function upsertMapping(
  sessionId: string | number,
  calendarId: string,
  googleEventId: string
): Promise<void> {
  await query(
    `INSERT INTO crm_session_google_events (session_id, calendar_id, google_event_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (session_id, calendar_id)
     DO UPDATE SET google_event_id = EXCLUDED.google_event_id, updated_at = CURRENT_TIMESTAMP`,
    [sessionId, calendarId, googleEventId]
  );
}

async function upsertFirstSessionMapping(
  firstSessionId: string | number,
  calendarId: string,
  googleEventId: string
): Promise<void> {
  await query(
    `INSERT INTO crm_first_session_google_events (first_session_id, calendar_id, google_event_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (first_session_id, calendar_id)
     DO UPDATE SET google_event_id = EXCLUDED.google_event_id, updated_at = CURRENT_TIMESTAMP`,
    [firstSessionId, calendarId, googleEventId]
  );
}

async function upsertGroupSessionMapping(
  groupSessionId: string | number,
  calendarId: string,
  googleEventId: string
): Promise<void> {
  await query(
    `INSERT INTO crm_group_session_google_events (group_session_id, calendar_id, google_event_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (group_session_id, calendar_id)
     DO UPDATE SET google_event_id = EXCLUDED.google_event_id, updated_at = CURRENT_TIMESTAMP`,
    [groupSessionId, calendarId, googleEventId]
  );
}

async function deleteMapping(sessionId: string | number, calendarId?: string): Promise<void> {
  if (calendarId) {
    await query(
      `DELETE FROM crm_session_google_events
       WHERE session_id = $1 AND calendar_id = $2`,
      [sessionId, calendarId]
    );
    return;
  }

  await query(
    `DELETE FROM crm_session_google_events
     WHERE session_id = $1`,
    [sessionId]
  );
}

async function deleteFirstSessionMapping(
  firstSessionId: string | number,
  calendarId?: string
): Promise<void> {
  if (calendarId) {
    await query(
      `DELETE FROM crm_first_session_google_events
       WHERE first_session_id = $1 AND calendar_id = $2`,
      [firstSessionId, calendarId]
    );
    return;
  }

  await query(
    `DELETE FROM crm_first_session_google_events
     WHERE first_session_id = $1`,
    [firstSessionId]
  );
}

async function deleteGroupSessionMapping(
  groupSessionId: string | number,
  calendarId?: string
): Promise<void> {
  if (calendarId) {
    await query(
      `DELETE FROM crm_group_session_google_events
       WHERE group_session_id = $1 AND calendar_id = $2`,
      [groupSessionId, calendarId]
    );
    return;
  }

  await query(
    `DELETE FROM crm_group_session_google_events
     WHERE group_session_id = $1`,
    [groupSessionId]
  );
}

async function createEvent(
  config: GoogleCalendarConfig,
  calendarId: string,
  payload: Record<string, unknown>,
  sendUpdates: GoogleSendUpdatesMode
): Promise<string> {
  const response = await googleCalendarRequest<GoogleCalendarEventResponse>(
    config,
    'POST',
    withSendUpdates(`/calendars/${encodeURIComponent(calendarId)}/events`, sendUpdates),
    payload,
    { disallowOauthFallback: sendUpdates === 'all' }
  );

  if (!response.id) {
    throw new Error(`Google Calendar did not return event id for calendar ${calendarId}.`);
  }

  return response.id;
}

async function updateEvent(
  config: GoogleCalendarConfig,
  calendarId: string,
  eventId: string,
  payload: Record<string, unknown>,
  sendUpdates: GoogleSendUpdatesMode
): Promise<void> {
  await googleCalendarRequest<GoogleCalendarEventResponse>(
    config,
    'PATCH',
    withSendUpdates(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      sendUpdates
    ),
    payload,
    { disallowOauthFallback: sendUpdates === 'all' }
  );
}

async function deleteEvent(
  config: GoogleCalendarConfig,
  calendarId: string,
  eventId: string,
  sendUpdates: GoogleSendUpdatesMode
): Promise<void> {
  await googleCalendarRequest<unknown>(
    config,
    'DELETE',
    withSendUpdates(
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      sendUpdates
    ),
    undefined,
    { disallowOauthFallback: sendUpdates === 'all' }
  );
}

async function getEvent(
  config: GoogleCalendarConfig,
  calendarId: string,
  eventId: string
): Promise<GoogleCalendarEventResponse> {
  return googleCalendarRequest<GoogleCalendarEventResponse>(
    config,
    'GET',
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`
  );
}

async function syncEventOnCalendar(
  session: SessionSyncRow,
  config: GoogleCalendarConfig,
  calendarId: string,
  payload: Record<string, unknown>,
  sendUpdates: GoogleSendUpdatesMode
): Promise<void> {
  const mapping = await getSessionMapping(session.id, calendarId);

  if (!mapping) {
    try {
      const googleEventId = await createEvent(config, calendarId, payload, sendUpdates);
      await upsertMapping(session.id, calendarId, googleEventId);
    } catch (error) {
      if (!isAttendeePermissionError(error) || !('attendees' in payload)) throw error;
      if (sendUpdates === 'all') throw error;
      const fallbackEventId = await createEvent(
        config,
        calendarId,
        withoutAttendees(payload),
        sendUpdates
      );
      await upsertMapping(session.id, calendarId, fallbackEventId);
    }
    return;
  }

  let shouldRecreateFromMapping = false;
  try {
    const existingEvent = await getEvent(config, calendarId, mapping.google_event_id);
    shouldRecreateFromMapping = existingEvent.status === 'cancelled';
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    shouldRecreateFromMapping = true;
  }

  if (shouldRecreateFromMapping) {
    try {
      const googleEventId = await createEvent(config, calendarId, payload, sendUpdates);
      await upsertMapping(session.id, calendarId, googleEventId);
    } catch (error) {
      if (!isAttendeePermissionError(error) || !('attendees' in payload)) throw error;
      if (sendUpdates === 'all') throw error;
      const fallbackEventId = await createEvent(
        config,
        calendarId,
        withoutAttendees(payload),
        sendUpdates
      );
      await upsertMapping(session.id, calendarId, fallbackEventId);
    }
    return;
  }

  try {
    await updateEvent(config, calendarId, mapping.google_event_id, payload, sendUpdates);
    await upsertMapping(session.id, calendarId, mapping.google_event_id);
  } catch (error) {
    if (isAttendeePermissionError(error) && 'attendees' in payload) {
      if (sendUpdates === 'all') throw error;
      await updateEvent(
        config,
        calendarId,
        mapping.google_event_id,
        withoutAttendees(payload),
        sendUpdates
      );
      await upsertMapping(session.id, calendarId, mapping.google_event_id);
      return;
    }
    if (!isNotFoundError(error)) throw error;

    try {
      const googleEventId = await createEvent(config, calendarId, payload, sendUpdates);
      await upsertMapping(session.id, calendarId, googleEventId);
    } catch (createError) {
      if (!isAttendeePermissionError(createError) || !('attendees' in payload)) throw createError;
      if (sendUpdates === 'all') throw createError;
      const fallbackEventId = await createEvent(
        config,
        calendarId,
        withoutAttendees(payload),
        sendUpdates
      );
      await upsertMapping(session.id, calendarId, fallbackEventId);
    }
  }
}

async function syncFirstSessionEventOnCalendar(
  firstSession: FirstSessionSyncRow,
  config: GoogleCalendarConfig,
  calendarId: string,
  payload: Record<string, unknown>,
  sendUpdates: GoogleSendUpdatesMode
): Promise<void> {
  const mapping = await getFirstSessionMapping(firstSession.id, calendarId);

  if (!mapping) {
    try {
      const googleEventId = await createEvent(config, calendarId, payload, sendUpdates);
      await upsertFirstSessionMapping(firstSession.id, calendarId, googleEventId);
    } catch (error) {
      if (!isAttendeePermissionError(error) || !('attendees' in payload)) throw error;
      if (sendUpdates === 'all') throw error;
      const fallbackEventId = await createEvent(
        config,
        calendarId,
        withoutAttendees(payload),
        sendUpdates
      );
      await upsertFirstSessionMapping(firstSession.id, calendarId, fallbackEventId);
    }
    return;
  }

  let shouldRecreateFromMapping = false;
  try {
    const existingEvent = await getEvent(config, calendarId, mapping.google_event_id);
    shouldRecreateFromMapping = existingEvent.status === 'cancelled';
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    shouldRecreateFromMapping = true;
  }

  if (shouldRecreateFromMapping) {
    try {
      const googleEventId = await createEvent(config, calendarId, payload, sendUpdates);
      await upsertFirstSessionMapping(firstSession.id, calendarId, googleEventId);
    } catch (error) {
      if (!isAttendeePermissionError(error) || !('attendees' in payload)) throw error;
      if (sendUpdates === 'all') throw error;
      const fallbackEventId = await createEvent(
        config,
        calendarId,
        withoutAttendees(payload),
        sendUpdates
      );
      await upsertFirstSessionMapping(firstSession.id, calendarId, fallbackEventId);
    }
    return;
  }

  try {
    await updateEvent(config, calendarId, mapping.google_event_id, payload, sendUpdates);
    await upsertFirstSessionMapping(firstSession.id, calendarId, mapping.google_event_id);
  } catch (error) {
    if (isAttendeePermissionError(error) && 'attendees' in payload) {
      if (sendUpdates === 'all') throw error;
      await updateEvent(
        config,
        calendarId,
        mapping.google_event_id,
        withoutAttendees(payload),
        sendUpdates
      );
      await upsertFirstSessionMapping(firstSession.id, calendarId, mapping.google_event_id);
      return;
    }
    if (!isNotFoundError(error)) throw error;

    try {
      const googleEventId = await createEvent(config, calendarId, payload, sendUpdates);
      await upsertFirstSessionMapping(firstSession.id, calendarId, googleEventId);
    } catch (createError) {
      if (!isAttendeePermissionError(createError) || !('attendees' in payload)) throw createError;
      if (sendUpdates === 'all') throw createError;
      const fallbackEventId = await createEvent(
        config,
        calendarId,
        withoutAttendees(payload),
        sendUpdates
      );
      await upsertFirstSessionMapping(firstSession.id, calendarId, fallbackEventId);
    }
  }
}

async function syncGroupSessionEventOnCalendar(
  groupSession: GroupSessionSyncRow,
  config: GoogleCalendarConfig,
  calendarId: string,
  payload: Record<string, unknown>
): Promise<void> {
  const mapping = await getGroupSessionMapping(groupSession.id, calendarId);

  if (!mapping) {
    const googleEventId = await createEvent(config, calendarId, payload, 'none');
    await upsertGroupSessionMapping(groupSession.id, calendarId, googleEventId);
    return;
  }

  let shouldRecreateFromMapping = false;
  try {
    const existingEvent = await getEvent(config, calendarId, mapping.google_event_id);
    shouldRecreateFromMapping = existingEvent.status === 'cancelled';
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
    shouldRecreateFromMapping = true;
  }

  if (shouldRecreateFromMapping) {
    const googleEventId = await createEvent(config, calendarId, payload, 'none');
    await upsertGroupSessionMapping(groupSession.id, calendarId, googleEventId);
    return;
  }

  try {
    await updateEvent(config, calendarId, mapping.google_event_id, payload, 'none');
    await upsertGroupSessionMapping(groupSession.id, calendarId, mapping.google_event_id);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;

    const googleEventId = await createEvent(config, calendarId, payload, 'none');
    await upsertGroupSessionMapping(groupSession.id, calendarId, googleEventId);
  }
}

async function removeMappingsFromOtherCalendars(
  sessionId: string | number,
  keepCalendarId: string,
  config: GoogleCalendarConfig,
  sendUpdates: GoogleSendUpdatesMode
): Promise<void> {
  const mappings = await getSessionMappings(sessionId);

  for (const mapping of mappings) {
    if (mapping.calendar_id === keepCalendarId) continue;

    try {
      await deleteEvent(config, mapping.calendar_id, mapping.google_event_id, sendUpdates);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }

    await deleteMapping(sessionId, mapping.calendar_id);
  }
}

async function removeFirstSessionMappingsFromOtherCalendars(
  firstSessionId: string | number,
  keepCalendarId: string,
  config: GoogleCalendarConfig,
  sendUpdates: GoogleSendUpdatesMode
): Promise<void> {
  const mappings = await getFirstSessionMappings(firstSessionId);

  for (const mapping of mappings) {
    if (mapping.calendar_id === keepCalendarId) continue;

    try {
      await deleteEvent(config, mapping.calendar_id, mapping.google_event_id, sendUpdates);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }

    await deleteFirstSessionMapping(firstSessionId, mapping.calendar_id);
  }
}

async function removeGroupSessionMappingsFromOtherCalendars(
  groupSessionId: string | number,
  keepCalendarId: string,
  config: GoogleCalendarConfig
): Promise<void> {
  const mappings = await getGroupSessionMappings(groupSessionId);

  for (const mapping of mappings) {
    if (mapping.calendar_id === keepCalendarId) continue;

    try {
      await deleteEvent(config, mapping.calendar_id, mapping.google_event_id, 'none');
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }

    await deleteGroupSessionMapping(groupSessionId, mapping.calendar_id);
  }
}

async function runWithRetries(
  operation: () => Promise<void>,
  maxAttempts = 3
): Promise<void> {
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      await operation();
      return;
    } catch (error) {
      if (attempt >= maxAttempts) throw error;
      const delayMs = 250 * attempt;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMs);
      });
    }
  }
}

export async function syncSessionToGoogleCalendars(
  sessionId: string | number,
  options: GoogleSyncOptions = {}
): Promise<void> {
  const requestedSendUpdates = options.sendUpdates;
  const config = getGoogleCalendarConfig();
  if (!config) {
    logMissingConfigOnce();
    return;
  }

  await ensureSessionCalendarColumns();
  await ensureGoogleEventsTable();

  const session = await getSessionForSync(sessionId);
  if (!session) return;
  const sendUpdates = getSessionSendUpdatesMode(session, requestedSendUpdates);

  if (shouldDeleteCalendarEvents(session)) {
    await removeSessionFromGoogleCalendars(session.id, { sendUpdates });
    return;
  }

  const targetCalendarId = getTargetCalendarId(session, config);
  const payload = buildGoogleEventPayload(session);

  await syncEventOnCalendar(session, config, targetCalendarId, payload, sendUpdates);
  await removeMappingsFromOtherCalendars(session.id, targetCalendarId, config, sendUpdates);
}

export async function removeSessionFromGoogleCalendars(
  sessionId: string | number,
  options: GoogleSyncOptions = {}
): Promise<void> {
  await ensureSessionCalendarColumns();
  await ensureGoogleEventsTable();
  const sendUpdates = await getStoredSessionSendUpdatesMode(sessionId, options.sendUpdates);

  const mappings = await getSessionMappings(sessionId);
  if (mappings.length === 0) return;

  const config = getGoogleCalendarConfig();
  if (!config) {
    logMissingConfigOnce();
    return;
  }

  for (const mapping of mappings) {
    try {
      await deleteEvent(config, mapping.calendar_id, mapping.google_event_id, sendUpdates);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }

    await deleteMapping(sessionId, mapping.calendar_id);
  }
}

export async function syncSessionToGoogleCalendarsSafe(
  sessionId: string | number,
  context: string,
  options: GoogleSyncOptions = {}
): Promise<void> {
  try {
    await runWithRetries(() => syncSessionToGoogleCalendars(sessionId, options));
  } catch (error) {
    console.error(`Google Calendar sync failed (${context})`, {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function removeSessionFromGoogleCalendarsSafe(
  sessionId: string | number,
  context: string,
  options: GoogleSyncOptions = {}
): Promise<void> {
  try {
    await runWithRetries(() => removeSessionFromGoogleCalendars(sessionId, options));
  } catch (error) {
    console.error(`Google Calendar removal failed (${context})`, {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function syncFirstSessionToGoogleCalendars(
  firstSessionId: string | number,
  options: GoogleSyncOptions = {}
): Promise<void> {
  const requestedSendUpdates = options.sendUpdates;
  const config = getGoogleCalendarConfig();
  if (!config) {
    logMissingConfigOnce();
    return;
  }

  await ensureFirstSessionCalendarColumns();
  await ensureGoogleEventsTable();

  const firstSession = await getFirstSessionForSync(firstSessionId);
  if (!firstSession) return;
  const sendUpdates = getFirstSessionSendUpdatesMode(firstSession, requestedSendUpdates);

  if (shouldDeleteFirstSessionCalendarEvents(firstSession)) {
    await removeFirstSessionFromGoogleCalendars(firstSession.id, { sendUpdates });
    return;
  }

  const targetCalendarId = config.privateCalendarId;
  const payload = buildFirstSessionGoogleEventPayload(firstSession);

  await syncFirstSessionEventOnCalendar(firstSession, config, targetCalendarId, payload, sendUpdates);
  await removeFirstSessionMappingsFromOtherCalendars(
    firstSession.id,
    targetCalendarId,
    config,
    sendUpdates
  );
}

export async function removeFirstSessionFromGoogleCalendars(
  firstSessionId: string | number,
  options: GoogleSyncOptions = {}
): Promise<void> {
  await ensureFirstSessionCalendarColumns();
  await ensureGoogleEventsTable();
  const sendUpdates = await getStoredFirstSessionSendUpdatesMode(
    firstSessionId,
    options.sendUpdates
  );

  const mappings = await getFirstSessionMappings(firstSessionId);
  if (mappings.length === 0) return;

  const config = getGoogleCalendarConfig();
  if (!config) {
    logMissingConfigOnce();
    return;
  }

  for (const mapping of mappings) {
    try {
      await deleteEvent(config, mapping.calendar_id, mapping.google_event_id, sendUpdates);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }

    await deleteFirstSessionMapping(firstSessionId, mapping.calendar_id);
  }
}

export async function syncFirstSessionToGoogleCalendarsSafe(
  firstSessionId: string | number,
  context: string,
  options: GoogleSyncOptions = {}
): Promise<void> {
  try {
    await runWithRetries(() => syncFirstSessionToGoogleCalendars(firstSessionId, options));
  } catch (error) {
    console.error(`Google Calendar first-session sync failed (${context})`, {
      firstSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function removeFirstSessionFromGoogleCalendarsSafe(
  firstSessionId: string | number,
  context: string,
  options: GoogleSyncOptions = {}
): Promise<void> {
  try {
    await runWithRetries(() => removeFirstSessionFromGoogleCalendars(firstSessionId, options));
  } catch (error) {
    console.error(`Google Calendar first-session removal failed (${context})`, {
      firstSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function syncGroupSessionToGoogleCalendars(
  groupSessionId: string | number
): Promise<void> {
  const config = getGoogleCalendarConfig();
  if (!config) {
    logMissingConfigOnce();
    return;
  }

  await ensureGoogleEventsTable();

  const groupSession = await getGroupSessionForSync(groupSessionId);
  if (!groupSession) return;

  const targetCalendarId = config.groupCalendarId;
  const payload = buildGroupSessionGoogleEventPayload(groupSession);

  await syncGroupSessionEventOnCalendar(groupSession, config, targetCalendarId, payload);
  await removeGroupSessionMappingsFromOtherCalendars(groupSession.id, targetCalendarId, config);
}

export async function removeGroupSessionFromGoogleCalendars(
  groupSessionId: string | number
): Promise<void> {
  await ensureGoogleEventsTable();

  const mappings = await getGroupSessionMappings(groupSessionId);
  if (mappings.length === 0) return;

  const config = getGoogleCalendarConfig();
  if (!config) {
    logMissingConfigOnce();
    return;
  }

  for (const mapping of mappings) {
    try {
      await deleteEvent(config, mapping.calendar_id, mapping.google_event_id, 'none');
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
    }

    await deleteGroupSessionMapping(groupSessionId, mapping.calendar_id);
  }
}

export async function syncGroupSessionToGoogleCalendarsSafe(
  groupSessionId: string | number,
  context: string
): Promise<void> {
  try {
    await runWithRetries(() => syncGroupSessionToGoogleCalendars(groupSessionId));
  } catch (error) {
    console.error(`Google Calendar group-session sync failed (${context})`, {
      groupSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function removeGroupSessionFromGoogleCalendarsSafe(
  groupSessionId: string | number,
  context: string
): Promise<void> {
  try {
    await runWithRetries(() => removeGroupSessionFromGoogleCalendars(groupSessionId));
  } catch (error) {
    console.error(`Google Calendar group-session removal failed (${context})`, {
      groupSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function syncUpcomingFirstSessionsToGoogleCalendars(daysAhead = 120): Promise<{
  total: number;
  synced: number;
  failed: number;
}> {
  await ensureFirstSessionCalendarColumns();
  await ensureGoogleEventsTable();

  const result = await query(
    `SELECT id
     FROM crm_first_sessions
     WHERE session_date >= NOW() - INTERVAL '1 day'
       AND session_date <= NOW() + ($1::text || ' days')::interval
       AND (status IS NULL OR status NOT IN ('cancelled', 'completed', 'no_show'))
       AND cancelled = false
     ORDER BY session_date ASC`,
    [String(daysAhead)]
  );

  let synced = 0;
  let failed = 0;

  for (const row of result.rows as Array<{ id: number }>) {
    try {
      await syncFirstSessionToGoogleCalendars(row.id, { sendUpdates: 'none' });
      synced += 1;
    } catch (error) {
      failed += 1;
      console.error('Failed to sync first session during bulk sync', {
        firstSessionId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    total: result.rows.length,
    synced,
    failed,
  };
}

export async function syncUpcomingSessionsToGoogleCalendars(daysAhead = 120): Promise<{
  total: number;
  synced: number;
  failed: number;
}> {
  await ensureGoogleEventsTable();

  const result = await query(
    `SELECT id
     FROM crm_sessions
     WHERE session_date >= NOW() - INTERVAL '1 day'
       AND session_date <= NOW() + ($1::text || ' days')::interval
       AND (status IS NULL OR status NOT IN ('cancelled', 'completed', 'no_show'))
       AND cancelled = false
     ORDER BY session_date ASC`,
    [String(daysAhead)]
  );

  let synced = 0;
  let failed = 0;

  for (const row of result.rows as Array<{ id: number }>) {
    try {
      await syncSessionToGoogleCalendars(row.id, { sendUpdates: 'none' });
      synced += 1;
    } catch (error) {
      failed += 1;
      console.error('Failed to sync session during bulk sync', {
        sessionId: row.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    total: result.rows.length,
    synced,
    failed,
  };
}

export async function clearFutureEventsFromManagedCalendars(
  fromDateISO?: string,
  daysAhead = 365
): Promise<{
  deleted: number;
}> {
  const config = getGoogleCalendarConfig();
  if (!config) {
    logMissingConfigOnce();
    return { deleted: 0 };
  }
  await ensureGoogleEventsTable();

  const fromDate = fromDateISO ? new Date(fromDateISO) : new Date();
  if (Number.isNaN(fromDate.getTime())) {
    throw new Error(`Invalid fromDateISO: ${fromDateISO}`);
  }
  const boundedDaysAhead = Math.max(1, Math.min(3650, Math.trunc(daysAhead)));
  const toDate = new Date(fromDate.getTime() + boundedDaysAhead * 24 * 60 * 60 * 1000);

  let deleted = 0;

  for (const calendarId of config.managedCalendarIds) {
    let pageToken: string | undefined;

    while (true) {
      const params = new URLSearchParams({
        singleEvents: 'true',
        timeMin: fromDate.toISOString(),
        timeMax: toDate.toISOString(),
        maxResults: '2500',
      });
      if (pageToken) params.set('pageToken', pageToken);

      const list = await googleCalendarRequest<GoogleCalendarEventListResponse>(
        config,
        'GET',
        `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`
      );

      const items = list.items || [];
      for (const item of items) {
        if (!item.id || item.status === 'cancelled') continue;
        await deleteEvent(config, calendarId, item.id, 'none');
        deleted += 1;
      }

      if (!list.nextPageToken) break;
      pageToken = list.nextPageToken;
    }
  }

  await query('DELETE FROM crm_session_google_events');
  await query('DELETE FROM crm_first_session_google_events');
  return { deleted };
}
