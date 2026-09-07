-- 0006_time_tracking.sql
-- Time-tracking schema: time_slice, active_timer.
--
-- Requirements:
--   R8     — support members record time spent actively working a request.
--   R8.2   — clicking "Working on It" starts a timer for that member against
--            that request (an active_timer row) without changing status.
--   R8.5   — when the presented duration is edited it MUST be > 1 minute; the
--            recorded slice minimum is 1 minute (CHECK duration_minutes >= 1).
--   R8.6   — a confirmed slice retains its duration and the member who recorded
--            it (time_slice.member_id).
--   R8.7   — multiple members may record slices against the same request, and a
--            single member may record more than one slice against the same
--            request — so time_slice has NO uniqueness on (request_id, member_id).
--   R8.8   — a member may have at most one OPEN timer per request; clicking
--            "Working on It" while a timer runs on ANOTHER request prompts them
--            to stop or leave it. unique(request_id, member_id) on active_timer
--            enforces the per-request/member limit while still permitting open
--            timers on different requests (the concurrent-timer case).
--   R8.9   — all slices are retained for effort/duration reporting.
--   R4.6/  — an open active_timer against a non-closed request drives the
--   R4.7     "(Working On)" indicator and effort/duration reporting; the
--   R12      request_id / member_id indexes keep those aggregations efficient.
--   R18.1  — ALL date/time columns are `timestamptz`.
--
-- Forward-only. Surrogate `bigint` identity PKs per the design's data model,
-- matching migrations 0002-0005. FKs reference request (0005) and
-- app_user (0002). The whole migration runs inside a single transaction
-- (see db/migrate.ts).

-- ─────────────────────────────────────────────────────────────────────────────
-- time_slice — a recorded period a member spent working a request while it was
-- Active (R8, R8.6, R8.7, R8.9). Slices are immutable records used for effort
-- and duration reporting (R4.7, R12).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE time_slice (
  id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id       bigint      NOT NULL REFERENCES request (id),
  -- The member who recorded the slice; retained for reporting (R8.6, R12).
  member_id        bigint      NOT NULL REFERENCES app_user (id),
  started_at       timestamptz NOT NULL,
  ended_at         timestamptz NOT NULL,
  -- Recorded/edited duration in minutes. Edited values must be > 1 minute
  -- (enforced in the service layer, R8.5); the stored minimum is 1.
  duration_minutes integer     NOT NULL
                               CONSTRAINT time_slice_duration_minutes_min
                               CHECK (duration_minutes >= 1),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Effort/duration reporting aggregates slices per request and per member
-- (R4.7, R8.9, R12). No uniqueness on (request_id, member_id): a request may
-- have many slices and a member may record several against one request (R8.7).
CREATE INDEX time_slice_request_id_idx ON time_slice (request_id);
CREATE INDEX time_slice_member_id_idx  ON time_slice (member_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- active_timer — an OPEN (running) timer for a member on a request
-- (R4.6, R8.2, R8.8). A row exists only while a timer runs; stopping it deletes
-- the row and (on confirm) writes a time_slice.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE active_timer (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id  bigint      NOT NULL REFERENCES request (id),
  member_id   bigint      NOT NULL REFERENCES app_user (id),
  started_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- At most one open timer per (request, member) so the concurrent-timer prompt
  -- (R8.8) can be resolved deterministically. A member CAN hold open timers on
  -- DIFFERENT requests — uniqueness is per request+member, not per member.
  CONSTRAINT active_timer_request_member_uniq UNIQUE (request_id, member_id)
);

-- Find all of a member's running timers (across requests) for the
-- concurrent-timer prompt (R8.8). The unique(request_id, member_id) constraint
-- already covers request_id-led lookups.
CREATE INDEX active_timer_member_id_idx ON active_timer (member_id);
