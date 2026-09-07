-- 0003_teams.sql
-- Teams & membership schema: team, team_member.
--
-- Requirements:
--   R13    — a team has a title, a description, and a team leader (an app_user).
--            Teams are created/managed by the administrator group.
--   R15    — team leaders manage their team's membership (add/remove members).
--   R20    — reference-data lifecycle: a team can be closed (R20.2) and members
--            removed (R20.3); those guards are enforced in the service layer
--            against open requests. The schema records the closed flag and the
--            membership rows the guards operate on.
--   R18.1  — ALL date/time columns are `timestamptz`.
--   R6     — support membership: a user is "support" for a team by virtue of a
--            team_member row; membership lookups by user drive that resolution.
--
-- Forward-only. Surrogate `bigint` identity PKs per the design's data model,
-- matching migration 0002. FKs reference the identity/org tables from 0002.

-- ─────────────────────────────────────────────────────────────────────────────
-- team — a support team owned by a leader (R13, R20).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE team (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title          text        NOT NULL,
  -- Optional free-text description of the team's remit.
  description    text,
  -- The team's leader. NOT NULL: every team has exactly one leader (R13).
  team_leader_id bigint      NOT NULL REFERENCES app_user (id),
  -- Closed teams are hidden from the New workflow; closing is guarded against
  -- open requests in the service layer (R20.2).
  is_closed      boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Membership/leadership lookups by leader stay efficient.
CREATE INDEX team_team_leader_id_idx ON team (team_leader_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- team_member — a user's membership of a team (R6, R15, R20.3).
-- A surrogate id keeps FKs from other tables (e.g. assignment) simple; the
-- (team_id, user_id) uniqueness prevents duplicate memberships.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE team_member (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  team_id     bigint      NOT NULL REFERENCES team (id),
  user_id     bigint      NOT NULL REFERENCES app_user (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  -- A user appears at most once per team (R20.3).
  CONSTRAINT team_member_team_user_uniq UNIQUE (team_id, user_id)
);

-- Index user_id for "which teams is this user a member of?" lookups (R6, R15).
-- The unique(team_id, user_id) constraint already covers team_id-led lookups.
CREATE INDEX team_member_user_id_idx ON team_member (user_id);
