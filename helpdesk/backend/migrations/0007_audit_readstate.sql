-- 0007_audit_readstate.sql
-- Audit & read-state schema: audit_entry, request_last_seen.
--
-- Requirements:
--   R17    — column-level audit trail: every audited field change records the
--            field, its old and new value, who made it and when. The audit is
--            generic across entity types (request, request_note, etc.) so a
--            single table serves the whole application (R17.1, R17.2).
--   R17.4  — request detail surfaces the audit trail for the request (the
--            (entity_type, entity_id) index drives that lookup).
--   R4.8   — the requests list shows an "Updated" indicator when a request has
--            a non-internal change after the viewing user last saw it.
--   R5.2   — opening a request records that the user has now seen it
--            (last_seen_at), clearing the "Updated" indicator for them.
--   R7.5/  — support-side "Updated" behaviour is computed the same way from the
--   R7.6     per-user last-seen timestamp vs non-internal changes.
--   R18.1  — ALL date/time columns are `timestamptz`.
--
-- Forward-only. Surrogate `bigint` identity PKs per the design's data model,
-- matching migrations 0002-0006. FKs reference app_user (0002) and
-- request (0005). The whole migration runs inside a single transaction
-- (see db/migrate.ts).
--
-- This task (2.6) creates the SCHEMA only. The audit-writer logic — writing
-- audit_entry rows in the same transaction as each mutation — is task 3.4.

-- ─────────────────────────────────────────────────────────────────────────────
-- audit_entry — a single column-level change record (R17). Generic across
-- entity types: `entity_type` + `entity_id` identify the audited row without a
-- hard FK, because the audited row may live in different tables (request,
-- request_note, ...). Referential integrity for entity_id is therefore the
-- audit writer's responsibility (task 3.4), not a schema constraint.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE audit_entry (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The kind of audited entity, e.g. 'request', 'request_note' (R17.1).
  entity_type   text        NOT NULL,
  -- The id of the audited row within its entity type. Generic — deliberately
  -- NOT a hard FK, since it spans entity types (see header).
  entity_id     bigint      NOT NULL,
  -- The changed field/column name (R17.1).
  field_name    text        NOT NULL,
  -- Prior and new values, captured as text; either may be NULL (e.g. a value
  -- being set for the first time, or cleared).
  old_value     text,
  new_value     text,
  -- The user who made the change (R17.1).
  changed_by_id bigint      NOT NULL REFERENCES app_user (id),
  -- Authoritative event time for the change (R17.1). `changed_at` is the audit
  -- timestamp used for ordering and the "Updated" computation.
  changed_at    timestamptz NOT NULL DEFAULT now(),
  -- Row-insert timestamp, for consistency with the other tables' convention.
  -- `changed_at` remains the authoritative event time.
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Fetching an entity's full audit trail (R17.4) is the hot path — index the
-- generic (entity_type, entity_id) key. The composite also covers the
-- "non-internal change since last_seen_at" scan for a given request (R4.8).
CREATE INDEX audit_entry_entity_idx ON audit_entry (entity_type, entity_id);

-- Support "changes by user" lookups / reporting.
CREATE INDEX audit_entry_changed_by_id_idx ON audit_entry (changed_by_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- request_last_seen — the last time a given user viewed a given request
-- (R4.8, R5.2, R7.5-7.6). Drives the per-user "Updated" indicator: a request is
-- "Updated" for a user when it has a non-internal change (an audit_entry /
-- external note) after that user's last_seen_at.
--
-- Surrogate id PK plus unique(request_id, user_id) — one last-seen row per
-- (request, user) — matching the team_member / request_field_value pattern from
-- prior migrations. Opening a request upserts this row (task 6.4).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE request_last_seen (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id   bigint      NOT NULL REFERENCES request (id),
  user_id      bigint      NOT NULL REFERENCES app_user (id),
  -- When this user last viewed the request (R5.2). Set explicitly on view, so
  -- no DEFAULT — the service supplies the value.
  last_seen_at timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- One last-seen row per (request, user) (R5.2). Enables upsert-on-view.
  CONSTRAINT request_last_seen_request_user_uniq UNIQUE (request_id, user_id)
);

-- The unique(request_id, user_id) constraint already covers request_id-led
-- lookups. Index the user_id side for "all requests this user has seen" scans
-- used when computing the "Updated" indicator across the requests list (R4.8).
CREATE INDEX request_last_seen_user_id_idx ON request_last_seen (user_id);
