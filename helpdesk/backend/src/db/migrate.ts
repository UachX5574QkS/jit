import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { pool, closePool } from './pool.js';

/**
 * Forward-only SQL migration runner.
 *
 * Discovers `*.sql` files in the migrations directory, applies any that have
 * not yet been recorded in `schema_migrations` (in ascending filename order),
 * and records each successful application. Re-running is idempotent: already
 * applied migrations are skipped.
 *
 * Each migration runs in its own transaction; a failure rolls that migration
 * back and aborts the run so the database is never left partially migrated.
 *
 * The file-selection/ordering logic is factored into pure functions
 * ({@link isMigrationFile}, {@link orderMigrations}, {@link pendingMigrations})
 * so it can be unit tested without a live database.
 */

/** Default migrations directory: `<backend>/migrations`, resolved from src/db. */
export const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../migrations', import.meta.url),
);

/** A migration file discovered on disk. */
export interface Migration {
  /** Version key stored in `schema_migrations` — filename without `.sql`. */
  readonly version: string;
  /** Bare filename, e.g. `0001_schema_migrations.sql`. */
  readonly filename: string;
}

/** True for regular, non-hidden `.sql` files. */
export function isMigrationFile(filename: string): boolean {
  return filename.endsWith('.sql') && !filename.startsWith('.');
}

/**
 * Turn a list of filenames into ordered {@link Migration} records.
 * Ordering is a stable, ascending sort on the filename, which — given the
 * zero-padded `NNNN_` naming convention — applies migrations in sequence.
 */
export function orderMigrations(filenames: readonly string[]): Migration[] {
  return filenames
    .filter(isMigrationFile)
    .slice()
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .map((filename) => ({
      version: filename.slice(0, -'.sql'.length),
      filename,
    }));
}

/**
 * Given the ordered, on-disk migrations and the set of versions already
 * applied, return only those still pending (preserving order).
 */
export function pendingMigrations(
  ordered: readonly Migration[],
  appliedVersions: ReadonlySet<string>,
): Migration[] {
  return ordered.filter((m) => !appliedVersions.has(m.version));
}

/** Read and order the migration files present in `dir`. */
export async function discoverMigrations(
  dir: string = MIGRATIONS_DIR,
): Promise<Migration[]> {
  const entries = await readdir(dir);
  return orderMigrations(entries);
}

/**
 * Ensure the tracking table exists, then return the set of applied versions.
 * The bootstrap `CREATE TABLE IF NOT EXISTS` mirrors migration `0001` so the
 * runner can query applied versions even on a brand-new database.
 */
async function readAppliedVersions(client: PoolClient): Promise<Set<string>> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version     text PRIMARY KEY,
       applied_at  timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const { rows } = await client.query<{ version: string }>(
    'SELECT version FROM schema_migrations',
  );
  return new Set(rows.map((r) => r.version));
}

/** Outcome of a migration run, useful for tests and CLI reporting. */
export interface MigrateResult {
  readonly applied: string[];
  readonly skipped: string[];
}

/**
 * Apply all pending migrations found in `dir`. Returns which versions were
 * applied and which were skipped (already present).
 */
export async function runMigrations(
  dir: string = MIGRATIONS_DIR,
): Promise<MigrateResult> {
  const ordered = await discoverMigrations(dir);

  const applied: string[] = [];
  const skipped: string[] = [];

  const bootstrapClient = await pool.connect();
  let appliedVersions: Set<string>;
  try {
    appliedVersions = await readAppliedVersions(bootstrapClient);
  } finally {
    bootstrapClient.release();
  }

  const pending = pendingMigrations(ordered, appliedVersions);
  for (const m of ordered) {
    if (appliedVersions.has(m.version)) {
      skipped.push(m.version);
    }
  }

  for (const migration of pending) {
    const sql = await readFile(path.join(dir, migration.filename), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // The migration SQL is code-controlled (files on disk), never user input.
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version) VALUES ($1)',
        [migration.version],
      );
      await client.query('COMMIT');
      applied.push(migration.version);
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Surface the original error below.
      }
      throw new Error(
        `Migration ${migration.filename} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    } finally {
      client.release();
    }
  }

  return { applied, skipped };
}

/** CLI entry point: `npm run migrate`. */
async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`Running migrations from ${MIGRATIONS_DIR}`);
  try {
    const { applied, skipped } = await runMigrations();
    // eslint-disable-next-line no-console
    console.log(
      `Migrations complete. Applied ${applied.length}` +
        (applied.length ? ` (${applied.join(', ')})` : '') +
        `, skipped ${skipped.length}` +
        (skipped.length ? ` (${skipped.join(', ')})` : '') +
        '.',
    );
  } finally {
    await closePool();
  }
}

// Run only when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Migration run failed:', err);
    process.exitCode = 1;
  });
}
