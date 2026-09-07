import { Pool } from 'pg';
import { config } from '../config/env.js';

/**
 * Shared PostgreSQL connection pool for the local `helpdesk` database.
 *
 * This is the minimal pool/connection wiring. Feature code must not use this
 * pool directly — it goes through the parameterised query/data-access layer in
 * `db/query.ts` (`query`, `one`, `many`, `withTransaction`). Schema changes are
 * applied by the migration runner in `db/migrate.ts` (`npm run migrate`).
 */
export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: config.db.poolMax,
});

/** Lightweight connectivity probe used by the health endpoint. */
export async function pingDatabase(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/** Gracefully close the pool on shutdown. */
export async function closePool(): Promise<void> {
  await pool.end();
}
