-- 0008_status_stop_states.sql
-- Status stop-state definition: request_status_stop_state lookup table.
--
-- Requirements:
--   R9.1  — the ten request statuses exist. The `request_status` enum type
--           (NEW, TRIAGE, ACCEPTED, ASSIGNED, ACTIVE, PAUSED, BLOCKED,
--           REJECTED, CANCELLED, COMPLETE, in lifecycle order) was created in
--           migration 0005_requests.sql, because the `request.status` column
--           depends on it. It is NOT recreated here (that would fail).
--   R9.3  — Rejected, Cancelled, and Complete are the stop (closed) states.
--           This migration records that fact authoritatively at the data
--           layer so the rest of the app has a single source of truth.
--   R18.1 — ALL date/time columns are `timestamptz`.
--
-- Forward-only. The whole migration runs inside a single transaction
-- (see db/migrate.ts).
--
-- WHY A LOOKUP TABLE (task 2.7):
-- The enum in 0005 already satisfies R9.1 (the set of statuses). Task 2.7 owns
-- the STOP-STATE definition (R9.3). Rather than scatter the "which statuses are
-- terminal" knowledge across queries, this migration records it once, keyed by
-- the enum, so it is authoritative AND joinable:
--   * the central state machine (task 3.5) treats REJECTED/CANCELLED/COMPLETE
--     as terminal (no outbound transitions; cancel allowed only from non-stop
--     states);
--   * "Hide Complete" list filters exclude Complete/Rejected/Cancelled
--     (R4.4, R6.5);
--   * statistics exclude Rejected/Cancelled from duration averages
--     (R10.5, R11.2, R12) and can join this table instead of hard-coding the
--     set.
-- The transition RULES themselves remain enforced centrally in the service
-- layer (task 3.5); this table is the authoritative definition of terminality,
-- not a transition table.

-- ─────────────────────────────────────────────────────────────────────────────
-- request_status_stop_state — one row per request_status value recording
-- whether that status is a stop (closed) state (R9.3).
--
-- Keyed directly by the `request_status` enum as the primary key: exactly one
-- row per status, and the FK-like coupling to the enum keeps the two in step.
-- Seeded below with all ten statuses; is_stop_state is true only for
-- REJECTED, CANCELLED, and COMPLETE.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE request_status_stop_state (
  status        request_status PRIMARY KEY,
  -- True iff `status` is a terminal / closed state (R9.3).
  is_stop_state boolean        NOT NULL,
  created_at    timestamptz    NOT NULL DEFAULT now(),
  updated_at    timestamptz    NOT NULL DEFAULT now()
);

-- Seed all ten statuses (R9.1) with their stop-state flag (R9.3). Listed in the
-- lifecycle order declared by the enum in 0005 for readability.
INSERT INTO request_status_stop_state (status, is_stop_state) VALUES
  ('NEW',       false),
  ('TRIAGE',    false),
  ('ACCEPTED',  false),
  ('ASSIGNED',  false),
  ('ACTIVE',    false),
  ('PAUSED',    false),
  ('BLOCKED',   false),
  ('REJECTED',  true),
  ('CANCELLED', true),
  ('COMPLETE',  true);

-- Partial index over the stop states — the common lookup is "is this status
-- terminal?" and list/statistics filters select the closed set specifically.
CREATE INDEX request_status_stop_state_is_stop_idx
  ON request_status_stop_state (status)
  WHERE is_stop_state;
