import type { PoolClient, QueryResultRow } from 'pg';
import { pool } from './pool.js';

/**
 * Parameterised query/data-access layer over the shared `pg` Pool.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * All feature code MUST reach the database through these helpers (or through
 * higher-level services built on them), never through the raw pool. This keeps
 * data access loosely coupled from the serving runtime (R22.4) so the future
 * migration to ORDS-served handlers is a reimplementation of the same contract
 * rather than a redesign.
 *
 * ── The one hard rule: NO string-interpolated values ─────────────────────────
 * Every SQL statement passed to these helpers MUST use positional placeholders
 * (`$1`, `$2`, …) for values, with the values supplied via the `params` array.
 * NEVER build SQL by concatenating or interpolating user/data values into the
 * `text` string — that is how SQL injection happens. `pg` sends parameters
 * separately from the statement text, so placeholders are safe by construction.
 *
 *   // GOOD — value travels in params, never in the SQL text
 *   await query('SELECT * FROM app_user WHERE username = $1', [username]);
 *
 *   // BAD — string interpolation of a value; do not do this, ever
 *   await query(`SELECT * FROM app_user WHERE username = '${username}'`);
 *
 * Identifiers (table/column names) cannot be parameterised by `pg`. Those must
 * come from trusted, code-controlled constants — never from request input.
 */

/** A value acceptable as a bound SQL parameter. */
export type SqlParam =
  | string
  | number
  | boolean
  | Date
  | null
  | Buffer
  | ReadonlyArray<string | number | boolean | Date | null>;

/**
 * A source of database access: either the shared pool or a client already
 * enlisted in a transaction. Passing a transaction client lets a mutation and
 * its audit write share one transaction (needed by task 3.4).
 */
export type Queryable = Pick<PoolClient, 'query'> | typeof pool;

/**
 * Run a parameterised statement and return all rows.
 *
 * @param text   SQL text using `$1`, `$2`, … placeholders for every value.
 * @param params Values bound to the placeholders, in order.
 * @param db     Optional queryable (a transaction client). Defaults to the pool.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: ReadonlyArray<SqlParam> = [],
  db: Queryable = pool,
): Promise<T[]> {
  const result = await db.query<T>(text, params as unknown[]);
  return result.rows;
}

/**
 * Run a parameterised statement expected to match at most one row.
 *
 * @returns the single row, or `null` when no rows matched.
 * @throws  when the statement returns more than one row (a programming error).
 */
export async function one<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: ReadonlyArray<SqlParam> = [],
  db: Queryable = pool,
): Promise<T | null> {
  const rows = await query<T>(text, params, db);
  if (rows.length > 1) {
    throw new Error(
      `one() expected at most 1 row but the query returned ${rows.length}`,
    );
  }
  return rows[0] ?? null;
}

/** Alias of {@link query} for call sites that read more naturally as "many". */
export async function many<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: ReadonlyArray<SqlParam> = [],
  db: Queryable = pool,
): Promise<T[]> {
  return query<T>(text, params, db);
}

/**
 * Run `fn` inside a single database transaction.
 *
 * A dedicated client is checked out of the pool and passed to `fn`; every
 * statement inside `fn` must be issued through that client so it participates
 * in the transaction. The transaction commits when `fn` resolves and rolls back
 * if it throws. The client is always released.
 *
 * This is the seam that lets a mutation and its column-level audit write happen
 * atomically in the same transaction (task 3.4).
 *
 *   await withTransaction(async (tx) => {
 *     await query('UPDATE request SET status = $1 WHERE id = $2', [next, id], tx);
 *     await query('INSERT INTO audit_entry (...) VALUES ($1, ...)', [...], tx);
 *   });
 */
export async function withTransaction<T>(
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore rollback failures; surface the original error below.
    }
    throw err;
  } finally {
    client.release();
  }
}
