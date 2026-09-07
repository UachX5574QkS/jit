-- 0005_requests.sql
-- Requests schema: request_status enum, request, request_field_value,
-- request_note.
--
-- Requirements:
--   R2     — a request is raised against a task (a specific, pinned
--            task_version) and captures typed field values (R2.14).
--   R3     — captured values are validated per data point on read/write; the
--            value store is generic text keyed by task_field (validation lives
--            in the service layer).
--   R4     — the requests list needs efficient scoping by raiser, team,
--            assignee, and status.
--   R5     — users may add notes (R5.3) and see request detail (R5.4).
--   R7     — support members add internal/external notes (R7.3-7.4).
--   R9     — a request carries a status from the lifecycle state machine.
--   R18.1  — ALL date/time columns are `timestamptz`.
--
-- Forward-only. Surrogate `bigint` identity PKs per the design's data model,
-- matching migrations 0002/0003/0004. FKs reference app_user (0002),
-- team (0003), and task_version / task_field (0004). The whole migration runs
-- inside a single transaction (see db/migrate.ts).

-- ─────────────────────────────────────────────────────────────────────────────
-- request_status — the request lifecycle states (R9.1).
--
-- The 10 values are declared in the lifecycle order documented in the design's
-- state machine: NEW → TRIAGE → ACCEPTED → ASSIGNED → ACTIVE, with PAUSED /
-- BLOCKED as holds, and REJECTED / CANCELLED / COMPLETE as stop states.
--
-- NOTE (task 2.7): task 2.7 formally owns the status enum and the stop-state
-- definitions (R9.1, R9.3). The enum type is created here — rather than blocking
-- on 2.7 — because the `request.status` column below cannot exist without it.
-- Task 2.7 will document/augment stop-state handling (e.g. any lookup/config
-- that records which states are terminal) on top of this type; the transition
-- rules themselves are enforced centrally in the service-layer state machine
-- (task 3.5), not in the schema.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TYPE request_status AS ENUM (
  'NEW',
  'TRIAGE',
  'ACCEPTED',
  'ASSIGNED',
  'ACTIVE',
  'PAUSED',
  'BLOCKED',
  'REJECTED',
  'CANCELLED',
  'COMPLETE'
);

-- ─────────────────────────────────────────────────────────────────────────────
-- request — a raised request pinned to a task_version (R2.14, R4, R9).
-- The pinned `task_version_id` preserves the layout the request was raised
-- against even if the task is later edited into a new version (R16.4).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE request (
  id                   bigint         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Human-facing reference shown across the UI; unique across all requests.
  task_reference       text           NOT NULL UNIQUE,
  -- Pins the exact task_version so the request's field layout is stable (R16.4).
  task_version_id      bigint         NOT NULL REFERENCES task_version (id),
  title                text           NOT NULL,
  -- The user who raised the request (R2, R4.1, R5).
  raised_by_id         bigint         NOT NULL REFERENCES app_user (id),
  -- The owning support team (R4, R6).
  team_id              bigint         NOT NULL REFERENCES team (id),
  -- The support member currently assigned; nullable until assigned (R6.6, R7.2).
  assigned_member_id   bigint         REFERENCES app_user (id),
  -- Lifecycle status; new requests start at NEW (R2.14, R9.1).
  status               request_status NOT NULL DEFAULT 'NEW',
  -- Optional linked Jira ticket number (R5.3, R7.1).
  jira_number          text,
  -- Owner-entered estimate; nullable (R4.5).
  estimated_start_date timestamptz,
  -- Actual start; nullable and may be in the future.
  actual_start_date    timestamptz,
  created_at           timestamptz    NOT NULL DEFAULT now(),
  updated_at           timestamptz    NOT NULL DEFAULT now()
);

-- Indexes for the requests list scopes: "my requests", team queues, "my queue"
-- (by assignee), and status filters / hide-complete (R4.1-4.4, R6).
CREATE INDEX request_raised_by_id_idx       ON request (raised_by_id);
CREATE INDEX request_team_id_idx            ON request (team_id);
CREATE INDEX request_assigned_member_id_idx ON request (assigned_member_id);
CREATE INDEX request_status_idx             ON request (status);

-- ─────────────────────────────────────────────────────────────────────────────
-- request_field_value — a captured value for one task_field of a request
-- (R2, R3, R5.4). Stored as generic text; the correct type is applied on
-- read/write per the data point (validation in the service layer, R3).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE request_field_value (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id    bigint      NOT NULL REFERENCES request (id),
  task_field_id bigint      NOT NULL REFERENCES task_field (id),
  -- Nullable: an optional field may hold no value.
  value         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- At most one value per (request, field) (R5.4).
  CONSTRAINT request_field_value_request_field_uniq UNIQUE (request_id, task_field_id)
);

-- The unique(request_id, task_field_id) constraint already covers request_id-led
-- lookups (fetching all of a request's field values). Index the task_field side
-- for value lookups by field.
CREATE INDEX request_field_value_task_field_id_idx ON request_field_value (task_field_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- request_note — a note added to a request (R5.3, R7.3-7.4). Internal notes are
-- visible to support only and never to the raiser/non-support viewers (R7.3);
-- that filtering is enforced in the service layer using `is_internal`.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE request_note (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id  bigint      NOT NULL REFERENCES request (id),
  author_id   bigint      NOT NULL REFERENCES app_user (id),
  -- Internal notes are support-only (R7.3-7.4); external notes are visible to
  -- the raiser too.
  is_internal boolean     NOT NULL DEFAULT false,
  body        text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Fetching a request's notes (chronologically) is the hot path on request detail.
CREATE INDEX request_note_request_id_idx ON request_note (request_id);
