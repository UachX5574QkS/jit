-- 0002_identity_org.sql
-- Identity & org schema: app_user, area_manager, admin_group.
--
-- Requirements:
--   R1     — a user is identified by an 8-digit username, a "firstname surname"
--            display name, an email, and a manager. Passwords are stored hashed
--            (the column holds the hash only; it is never exposed or logged).
--   R18.1  — ALL date/time columns are `timestamptz`.
--   R19.2/ — the area-manager designation lives in its own lookup table
--   R19.3    (`area_manager`), NOT as a column on `app_user`.
--
-- Forward-only. Surrogate `bigint` identity PKs per the design's data model.

-- ─────────────────────────────────────────────────────────────────────────────
-- app_user — core identity/org record.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE app_user (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- 8-digit username, unique. CHECK enforces exactly 8 digits (R1, R1.2).
  username      text        NOT NULL UNIQUE
                            CONSTRAINT app_user_username_8_digits
                            CHECK (username ~ '^[0-9]{8}$'),
  first_name    text        NOT NULL,
  surname       text        NOT NULL,
  email         text        NOT NULL,
  -- Self-referencing manager link; nullable (top of a chain has no manager).
  manager_id    bigint      REFERENCES app_user (id),
  -- One-way hash only. Never selected into API responses or logs (R1.5).
  password_hash text        NOT NULL,
  -- Preferred timezone; nullable — the UI falls back to the browser (R18.2).
  timezone      text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Index the self-FK to keep hierarchy traversal (R19) efficient.
CREATE INDEX app_user_manager_id_idx ON app_user (manager_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- area_manager — separate lookup marking users whose hierarchy starts at
-- themselves and does not traverse upward (R19.2). Kept off app_user (R19.3).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE area_manager (
  user_id     bigint      NOT NULL UNIQUE REFERENCES app_user (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- admin_group — membership of the administrator group (R1.8, R13.1).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE admin_group (
  user_id     bigint      NOT NULL UNIQUE REFERENCES app_user (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
