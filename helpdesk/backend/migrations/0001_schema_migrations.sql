-- 0001_schema_migrations.sql
-- Bootstrap migration: creates the tracking table the migration runner uses to
-- record which migrations have already been applied. Forward-only and
-- idempotent — safe to re-run.
--
-- Domain tables (app_user, team, request, …) are intentionally NOT defined
-- here; they are authored as their own ordered migrations in Task 2.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version     text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
