# Database migrations

Ordered, forward-only SQL migrations applied by the migration runner
(`src/db/migrate.ts`, run via `npm run migrate`).

## Conventions

- One migration per file, named `NNNN_short_description.sql` where `NNNN` is a
  zero-padded, strictly increasing sequence (e.g. `0001_`, `0002_`).
- Files are discovered and applied in ascending filename order.
- The runner records each applied file's version (the filename without the
  `.sql` extension) in the `schema_migrations` table and skips it on re-runs, so
  running `npm run migrate` repeatedly is idempotent.
- Each migration runs inside its own transaction — if a file fails, its changes
  roll back and the runner stops.
- Migrations are **forward-only**: there is no automatic "down"/rollback. To
  change something already applied, add a new migration.
- Write plain SQL. Use `timestamptz` for all date/time columns per the design.

`0001_schema_migrations.sql` bootstraps the tracking table itself. The domain
schema (identity/org, teams, tasks, requests, time tracking, audit) is authored
as subsequent migrations in Task 2.
