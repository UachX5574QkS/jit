-- TAB_IDCS_USERS table
-- Lookup table for IDCS user identities including display name, email, manager, and department.
-- This table acts as the user directory referenced by all MCR-related foreign keys.

CREATE TABLE tab_idcs_users (
    user_id              NUMBER         NOT NULL
                         CONSTRAINT con_idcs_users_pk PRIMARY KEY,
    username             VARCHAR2(200)  NOT NULL,
    display_name         VARCHAR2(400),
    email                VARCHAR2(400),
    manager_id           NUMBER,
    department_id        NUMBER
);

COMMENT ON TABLE tab_idcs_users IS 'IDCS user identity lookup table containing user details for MCR ownership, assignment, and audit references';
COMMENT ON COLUMN tab_idcs_users.user_id IS 'Numeric IDCS user identifier (primary key)';
COMMENT ON COLUMN tab_idcs_users.username IS 'IDCS username';
COMMENT ON COLUMN tab_idcs_users.display_name IS 'User display name for UI presentation';
COMMENT ON COLUMN tab_idcs_users.email IS 'User email address for notifications';
COMMENT ON COLUMN tab_idcs_users.manager_id IS 'Manager user ID (self-referencing)';
COMMENT ON COLUMN tab_idcs_users.department_id IS 'Department identifier';
