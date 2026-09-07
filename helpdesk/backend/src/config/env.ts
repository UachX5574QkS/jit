import 'dotenv/config';

/**
 * Centralised, typed access to environment configuration.
 *
 * Sensible development defaults are provided so the backend boots on a fresh
 * laptop with no `.env` present. Copy `.env.example` to `.env` to override.
 */

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** The runtime environment the backend is running in. */
export type Environment = 'development' | 'production' | 'test';

export interface AppConfig {
  readonly port: number;
  /**
   * The resolved runtime environment (from `NODE_ENV`, defaulting to
   * `development`). Anything other than `production`/`test` is treated as
   * `development`. Dev-only surfaces (e.g. the login drop-down endpoint,
   * R1.2) key off {@link isDevelopment}.
   */
  readonly env: Environment;
  /** Origins permitted by CORS during local development. */
  readonly corsOrigins: string[];
  readonly session: {
    readonly cookieName: string;
    readonly secret: string;
    /**
     * Whether the session cookie is set with the `Secure` attribute. On in
     * production (cookie only sent over HTTPS); off in development so the
     * cookie flows over plain HTTP on `localhost`.
     */
    readonly secureCookie: boolean;
  };
  readonly db: {
    readonly host: string;
    readonly port: number;
    readonly database: string;
    readonly user: string;
    readonly password: string;
    readonly poolMax: number;
  };
  /**
   * Locally running Ollama service used by `POST /api/review/summary` to
   * generate the New-workflow Step 3 summary (R2.11). The call is made
   * server-side (the model endpoint never touches the browser) with a short
   * timeout; any error/timeout degrades to the entered-values fallback (R2.12).
   */
  readonly ollama: {
    /** Base URL of the local Ollama server (no trailing slash). */
    readonly baseUrl: string;
    /** The model name asked to produce the summary. */
    readonly model: string;
    /**
     * Server-side timeout for the summary call, in milliseconds. Kept short so
     * a slow/unavailable model falls back to the entered values quickly (R2.12)
     * rather than stalling Step 3.
     */
    readonly timeoutMs: number;
  };
}

/** Resolve `NODE_ENV` into one of the known {@link Environment} values. */
function resolveEnv(value: string | undefined): Environment {
  return value === 'production' || value === 'test' ? value : 'development';
}

export const config: AppConfig = {
  port: num(process.env['PORT'], 3000),
  env: resolveEnv(process.env['NODE_ENV']),
  corsOrigins: (process.env['CORS_ORIGIN'] ?? 'http://localhost:4200')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  session: {
    cookieName: process.env['SESSION_COOKIE_NAME'] ?? 'helpdesk_sid',
    secret: process.env['SESSION_SECRET'] ?? 'dev-only-change-me',
    secureCookie: process.env['NODE_ENV'] === 'production',
  },
  db: {
    host: process.env['PGHOST'] ?? 'localhost',
    port: num(process.env['PGPORT'], 5432),
    database: process.env['PGDATABASE'] ?? 'helpdesk',
    user: process.env['PGUSER'] ?? 'helpdesk',
    password: process.env['PGPASSWORD'] ?? 'helpdesk',
    poolMax: num(process.env['PG_POOL_MAX'], 10),
  },
  ollama: {
    baseUrl: (process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434').replace(/\/+$/, ''),
    model: process.env['OLLAMA_MODEL'] ?? 'llama3.2',
    timeoutMs: num(process.env['OLLAMA_TIMEOUT_MS'], 4000),
  },
};

/** True when the backend is running in the development environment. */
export function isDevelopment(): boolean {
  return config.env === 'development';
}
