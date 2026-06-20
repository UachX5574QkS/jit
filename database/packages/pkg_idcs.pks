CREATE OR REPLACE PACKAGE pkg_idcs AS
    -------------------------------------------------------------------------------
    -- PKG_IDCS - IDCS REST API Client (Simulated)
    --
    -- Low-level interface for Oracle IDCS operations: OAuth token management,
    -- group membership queries, user password management, and group member
    -- add/remove operations.
    --
    -- This implementation is SIMULATED - all functions return mock/hardcoded data
    -- rather than calling real IDCS APIs.
    --
    -- Requirements: 1.1, 2.4
    -------------------------------------------------------------------------------

    ---------------------------------------------------------------------------
    -- get_oauth_token
    -- Retrieves (or simulates retrieval of) an OAuth2 access token for the
    -- specified tenancy using stored client_id/client_secret credentials.
    --
    -- Parameters:
    --   p_tenancy_id  - ID of the IDCS tenancy record in IDCS_TENANCY table
    --
    -- Returns:
    --   VARCHAR2 - OAuth2 bearer token string
    ---------------------------------------------------------------------------
    FUNCTION get_oauth_token (
        p_tenancy_id IN NUMBER
    ) RETURN VARCHAR2;

    ---------------------------------------------------------------------------
    -- get_user_groups
    -- Returns the list of IDCS group names that the specified user belongs to.
    --
    -- Parameters:
    --   p_tenancy_id  - ID of the IDCS tenancy record
    --   p_username    - Username to query group memberships for
    --
    -- Returns:
    --   SYS.ODCIVARCHAR2LIST - Collection of group name strings
    ---------------------------------------------------------------------------
    FUNCTION get_user_groups (
        p_tenancy_id IN NUMBER,
        p_username   IN VARCHAR2
    ) RETURN SYS.ODCIVARCHAR2LIST;

    ---------------------------------------------------------------------------
    -- add_group_member
    -- Adds a user to the specified IDCS group (simulates PATCH to
    -- /Groups/{id}/members).
    --
    -- Parameters:
    --   p_tenancy_id  - ID of the IDCS tenancy record
    --   p_group_name  - Name of the target IDCS group
    --   p_username    - Username to add to the group
    ---------------------------------------------------------------------------
    PROCEDURE add_group_member (
        p_tenancy_id IN NUMBER,
        p_group_name IN VARCHAR2,
        p_username   IN VARCHAR2
    );

    ---------------------------------------------------------------------------
    -- remove_group_member
    -- Removes a user from the specified IDCS group (simulates PATCH to
    -- /Groups/{id}/members).
    --
    -- Parameters:
    --   p_tenancy_id  - ID of the IDCS tenancy record
    --   p_group_name  - Name of the target IDCS group
    --   p_username    - Username to remove from the group
    ---------------------------------------------------------------------------
    PROCEDURE remove_group_member (
        p_tenancy_id IN NUMBER,
        p_group_name IN VARCHAR2,
        p_username   IN VARCHAR2
    );

    ---------------------------------------------------------------------------
    -- set_user_password
    -- Sets the password for an IDCS user (simulates PATCH to /Users/{id}).
    --
    -- Parameters:
    --   p_tenancy_id    - ID of the IDCS tenancy record
    --   p_username      - Username whose password will be set
    --   p_new_password  - The new password value to set
    ---------------------------------------------------------------------------
    PROCEDURE set_user_password (
        p_tenancy_id   IN NUMBER,
        p_username     IN VARCHAR2,
        p_new_password IN VARCHAR2
    );

    ---------------------------------------------------------------------------
    -- get_group_members
    -- Returns the list of usernames that are members of the specified
    -- IDCS group.
    --
    -- Parameters:
    --   p_tenancy_id  - ID of the IDCS tenancy record
    --   p_group_name  - Name of the IDCS group to list members for
    --
    -- Returns:
    --   SYS.ODCIVARCHAR2LIST - Collection of username strings
    ---------------------------------------------------------------------------
    FUNCTION get_group_members (
        p_tenancy_id IN NUMBER,
        p_group_name IN VARCHAR2
    ) RETURN SYS.ODCIVARCHAR2LIST;

END pkg_idcs;
/
