-- 0004_tasks.sql
-- Versioned task model: data_point, task, task_version, task_field.
--
-- Requirements:
--   R14    — data points are reusable field definitions (name, data type,
--            description, default help text) maintained by administrators, and
--            can be retired. Dropdown/regexp specifics live on the definition.
--   R16    — tasks belong to a team and are versioned: editing a task creates a
--            new task_version with a fresh set of task_field rows so that
--            requests already raised against a prior version keep their layout
--            (R16.4). The current (latest) version is what new requests use
--            (R16.5). A task_field may override description/help text but NEVER
--            the name or data type (R16.3) — enforced in the service layer by
--            the deliberate absence of name/data_type override columns here.
--            Tasks can be retired (R16.6).
--   R18.1  — ALL date/time columns are `timestamptz`.
--
-- Forward-only. Surrogate `bigint` identity PKs per the design's data model,
-- matching migrations 0002/0003. FKs reference team (0003) and, within this
-- file, the versioned-task tables.
--
-- Note on the task <-> task_version mutual reference: `task.current_version_id`
-- points at a `task_version`, while `task_version.task_id` points back at the
-- `task`. To resolve the cycle cleanly, `current_version_id` is created as a
-- nullable column and its FK is added via ALTER TABLE after both tables exist.
-- The entire migration runs inside a single transaction (see db/migrate.ts),
-- so the ALTER is atomic with the CREATEs. `current_version_id` stays nullable:
-- a task exists momentarily before its first version is created, and the
-- service layer sets it once the first task_version row is inserted.

-- ─────────────────────────────────────────────────────────────────────────────
-- data_point_type — the set of supported data point data types (R14, R3.1).
-- A Postgres ENUM keeps the type set closed and self-documenting; new types are
-- added with a later ALTER TYPE ... ADD VALUE migration.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE data_point_type AS ENUM (
  'TEXT',
  'EMAIL',
  'DATE',
  'NUMERIC',
  'DATETIME',
  'TIME',
  'BOOLEAN',
  'DROPDOWN',
  'REGEXP'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- data_point — a reusable field definition maintained by administrators (R14).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE data_point (
  id                bigint          GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name              text            NOT NULL,
  data_type         data_point_type NOT NULL,
  -- Optional admin-facing description and the default "?" help text shown next
  -- to a field unless a task_field overrides it (R14.2, R2.6).
  description       text,
  default_help_text text,
  -- REGEXP data points validate values against this pattern (R3.4).
  regexp_pattern    text,
  -- DROPDOWN data points carry a default option list; task fields may override
  -- it (R3.5). Stored as a JSONB array of option values.
  default_options   jsonb,
  -- Retired data points can't be chosen for NEW task definitions but stay
  -- operational for task versions already using them (R14.3, R14.4, R20.4).
  is_retired        boolean         NOT NULL DEFAULT false,
  created_at        timestamptz     NOT NULL DEFAULT now(),
  updated_at        timestamptz     NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- task — a request type owned by a team, versioned on change (R16.6).
-- `current_version_id` is a nullable FK to task_version (added below) that
-- points at the latest version new requests should use (R16.5).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE task (
  id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id            bigint      NOT NULL REFERENCES team (id),
  name               text        NOT NULL,
  -- Retired tasks can't be selected for new requests but stay associated with
  -- requests already raised against them (R16.6, R20.4).
  is_retired         boolean     NOT NULL DEFAULT false,
  -- Latest version pointer. Nullable: a task is created before its first
  -- version exists; the FK constraint is added after task_version exists.
  current_version_id bigint,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Lookups of a team's tasks (New workflow, team-leader management) stay fast.
CREATE INDEX task_team_id_idx ON task (team_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- task_version — an immutable snapshot of a task's layout (R16.4-16.5).
-- Editing a task creates a new version (fresh task_field rows); existing
-- requests reference the version they were raised against to preserve layout.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE task_version (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id       bigint      NOT NULL REFERENCES task (id),
  -- Monotonically increasing per task; unique within a task.
  version_no    integer     NOT NULL,
  -- Support notes shown to support members via the "Help" button (R16.7).
  support_notes text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- One row per (task, version_no) (R16.4).
  CONSTRAINT task_version_task_version_no_uniq UNIQUE (task_id, version_no)
);

-- Lookups of all versions for a task.
CREATE INDEX task_version_task_id_idx ON task_version (task_id);

-- Resolve the task <-> task_version cycle: add the current-version FK now that
-- task_version exists. Runs in the same transaction as the CREATEs above.
ALTER TABLE task
  ADD CONSTRAINT task_current_version_id_fkey
  FOREIGN KEY (current_version_id) REFERENCES task_version (id);

CREATE INDEX task_current_version_id_idx ON task (current_version_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- task_field — a field within a task_version, immutable once versioned
-- (R16.2-16.3). Maps a data_point into a version at a given order, with an
-- optional description/help-text/options override. There is deliberately NO
-- name or data_type override column: a task field may override description and
-- help text but NEVER the name or data type (R16.3).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE task_field (
  id                   bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_version_id      bigint      NOT NULL REFERENCES task_version (id),
  data_point_id        bigint      NOT NULL REFERENCES data_point (id),
  -- Display order of the field within its version (R16.2).
  field_order          integer     NOT NULL,
  is_mandatory         boolean     NOT NULL DEFAULT false,
  -- Optional overrides of the data point's defaults (R16.3).
  help_text_override   text,
  description_override text,
  -- DROPDOWN-only override of the data point's default option list (R3.5,
  -- R16.2). JSONB array of option values.
  options_override     jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

-- Fetching a version's fields (in order) is the hot path for the New workflow
-- and request rendering.
CREATE INDEX task_field_task_version_id_idx ON task_field (task_version_id);
CREATE INDEX task_field_data_point_id_idx ON task_field (data_point_id);
