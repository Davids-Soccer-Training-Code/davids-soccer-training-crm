import { Pool } from "pg";

// Lazy pool creation - only create when first used
let pool: Pool | null = null;
let loggedSslModeUpgrade = false;
let loggedDbConfig = false;

function parseBoundedInt(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const intValue = Math.trunc(parsed);
  return Math.max(min, Math.min(max, intValue));
}

const DB_POOL_MAX = parseBoundedInt(process.env.DB_POOL_MAX, 2, 1, 50);
const DB_IDLE_TIMEOUT_MS = parseBoundedInt(
  process.env.DB_POOL_IDLE_TIMEOUT_MS,
  10000,
  1000,
  10 * 60 * 1000
);
const DB_CONNECT_TIMEOUT_MS = parseBoundedInt(
  process.env.DB_CONNECT_TIMEOUT_MS,
  30000,
  1000,
  120000
);
const DB_QUERY_RETRIES = parseBoundedInt(process.env.DB_QUERY_RETRIES, 4, 0, 8);

function getConnectionTelemetry(connectionString: string): {
  host?: string;
  database?: string;
  sslMode?: string;
} {
  try {
    const parsed = new URL(connectionString);
    const database = parsed.pathname?.replace(/^\//, "") || undefined;
    return {
      host: parsed.hostname || undefined,
      database,
      sslMode: parsed.searchParams.get("sslmode") || undefined,
    };
  } catch {
    return {};
  }
}

function normalizeDatabaseUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const sslMode = parsed.searchParams.get("sslmode");

    if (sslMode && ["prefer", "require", "verify-ca"].includes(sslMode)) {
      parsed.searchParams.set("sslmode", "verify-full");
      if (!loggedSslModeUpgrade) {
        console.log(
          `Upgrading DATABASE_URL sslmode from "${sslMode}" to "verify-full" for secure pg defaults`
        );
        loggedSslModeUpgrade = true;
      }
    }

    return parsed.toString();
  } catch {
    // If DATABASE_URL cannot be parsed as a URL, use it as-is.
    return rawUrl;
  }
}

function getErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") return code;

  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) return null;

  const causeCode = (cause as { code?: unknown }).code;
  return typeof causeCode === "string" ? causeCode : null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as Error & { cause?: unknown }).cause;
    if (cause instanceof Error) {
      return `${error.message} ${cause.message}`.trim();
    }
    if (typeof cause === "string") {
      return `${error.message} ${cause}`.trim();
    }
    return error.message;
  }

  if (typeof error === "string") return error;
  return String(error);
}

function isTransientConnectionError(error: unknown): boolean {
  const code = getErrorCode(error);
  if (
    code &&
    [
      "ECONNRESET",
      "ETIMEDOUT",
      "EPIPE",
      "08000",
      "08001",
      "08006",
      "57P01",
      "53300",
    ].includes(code)
  ) {
    return true;
  }

  const message = getErrorMessage(error).toLowerCase();
  return [
    "connection terminated due to connection timeout",
    "connection terminated unexpectedly",
    "timeout expired",
    "connection timeout",
    "could not connect to server",
    "server closed the connection unexpectedly",
    "too many clients already",
  ].some((needle) => message.includes(needle));
}

function getRetryDelayMs(attempt: number): number {
  return Math.min(1500, 200 * 2 ** Math.max(0, attempt - 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function resetPool(reason: string, sourceError?: unknown): Promise<void> {
  const stalePool = pool;
  pool = null;

  if (!stalePool) return;

  console.warn("Resetting PostgreSQL pool", {
    reason,
    error: sourceError ? getErrorMessage(sourceError) : undefined,
  });

  try {
    await stalePool.end();
  } catch (closeError) {
    console.error("Error closing stale PostgreSQL pool", closeError);
  }
}

function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set in environment variables");
    }
    pool = new Pool({
      connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL),
      max: DB_POOL_MAX,
      idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
      keepAlive: true,
      allowExitOnIdle: true,
      options: '-c timezone=UTC',
    });

    if (!loggedDbConfig) {
      const telemetry = getConnectionTelemetry(process.env.DATABASE_URL);
      console.log("Initialized PostgreSQL pool", {
        max: DB_POOL_MAX,
        idleTimeoutMillis: DB_IDLE_TIMEOUT_MS,
        connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
        queryRetries: DB_QUERY_RETRIES,
        host: telemetry.host,
        database: telemetry.database,
        sslMode: telemetry.sslMode,
      });
      loggedDbConfig = true;
    }

    pool.on("connect", () => {
      console.log("Connected to PostgreSQL database");
    });

    pool.on("error", (err) => {
      console.error("Unexpected error on idle client", err);
      // Do not kill the serverless process on transient idle disconnects.
      // Reset the pool reference so the next query recreates a fresh pool.
      void resetPool("idle client error", err);
    });
  }
  return pool;
}

// Helper function to query the database
export async function query(text: string, params?: unknown[]) {
  const totalAttempts = DB_QUERY_RETRIES + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const start = Date.now();
    try {
      const currentPool = getPool();
      const res = await currentPool.query(text, params);
      const duration = Date.now() - start;
      console.log("Executed query", { text, duration, rows: res.rowCount });
      return res;
    } catch (error) {
      const isTransient = isTransientConnectionError(error);
      const isLastAttempt = attempt >= totalAttempts;

      console.error("Database query error:", {
        attempt,
        totalAttempts,
        transient: isTransient,
        message: getErrorMessage(error),
        code: getErrorCode(error),
      });

      if (!isTransient || isLastAttempt) {
        throw error;
      }

      await resetPool(`transient query failure on attempt ${attempt}`, error);
      await sleep(getRetryDelayMs(attempt));
    }
  }

  throw new Error("Unreachable: query exhausted retries");
}

// Helper function to get a client for transactions
export async function getClient() {
  const totalAttempts = DB_QUERY_RETRIES + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    try {
      const currentPool = getPool();
      const client = await currentPool.connect();
      return client;
    } catch (error) {
      const isTransient = isTransientConnectionError(error);
      const isLastAttempt = attempt >= totalAttempts;

      console.error("Database connect error:", {
        attempt,
        totalAttempts,
        transient: isTransient,
        message: getErrorMessage(error),
        code: getErrorCode(error),
      });

      if (!isTransient || isLastAttempt) {
        throw error;
      }

      await resetPool(`transient connect failure on attempt ${attempt}`, error);
      await sleep(getRetryDelayMs(attempt));
    }
  }

  throw new Error("Unreachable: connect exhausted retries");
}

export { getPool };
export default getPool;
