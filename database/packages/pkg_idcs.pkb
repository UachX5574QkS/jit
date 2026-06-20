CREATE OR REPLACE PACKAGE BODY pkg_idcs AS
    -------------------------------------------------------------------------------
    -- PKG_IDCS Package Body (Simulated Implementation)
    --
    -- All functions return mock/hardcoded data rather than calling real IDCS APIs.
    -- In production, these would use APEX_WEB_SERVICE or UTL_HTTP with 30-second
    -- timeouts to communicate with the IDCS REST API.
    --
    -- Requirements: 1.1, 2.4, 2.5
    -------------------------------------------------------------------------------

    ---------------------------------------------------------------------------
    -- get_oauth_token
    -- Simulates OAuth2 token retrieval using stored client_id/client_secret.
    -- In production: POST to {stripe_url}/oauth2/v1/token with Basic auth header
    -- containing Base64(client_id:client_secret), grant_type=client_credentials.
    -- Token would be cached in a package-level variable until expiry.
    ---------------------------------------------------------------------------
    FUNCTION get_oauth_token (
        p_tenancy_id IN NUMBER
    ) RETURN VARCHAR2
    IS
        l_tenancy_identifier VARCHAR2(100);
    BEGIN
        -- In production: check cached token, return if still valid.
        -- Otherwise, fetch tenancy credentials and call IDCS token endpoint.
        BEGIN
            SELECT tenancy_identifier
              INTO l_tenancy_identifier
              FROM idcs_tenancy
             WHERE tenancy_id = p_tenancy_id;
        EXCEPTION
            WHEN NO_DATA_FOUND THEN
                RAISE_APPLICATION_ERROR(-20001, 'Tenancy ID ' || p_tenancy_id || ' not found');
        END;

        DBMS_OUTPUT.PUT_LINE('[PKG_IDCS] get_oauth_token: Simulated token for tenancy "' || l_tenancy_identifier || '" (ID: ' || p_tenancy_id || ')');

        RETURN 'SIMULATED_TOKEN_' || p_tenancy_id;
    END get_oauth_token;

    ---------------------------------------------------------------------------
    -- get_user_groups
    -- Simulates fetching IDCS group memberships for a user.
    -- In production: GET {stripe_url}/admin/v1/Groups?filter=members.value eq "{user_id}"
    -- with Bearer token, parse JSON, return collection of group displayNames.
    ---------------------------------------------------------------------------
    FUNCTION get_user_groups (
        p_tenancy_id IN NUMBER,
        p_username   IN VARCHAR2
    ) RETURN SYS.ODCIVARCHAR2LIST
    IS
        l_groups SYS.ODCIVARCHAR2LIST;
    BEGIN
        DBMS_OUTPUT.PUT_LINE('[PKG_IDCS] get_user_groups: Simulated groups for user "' || p_username || '" in tenancy ' || p_tenancy_id);

        -- Return a hardcoded set of groups representing JIT break-glass pattern.
        -- These cover both the base, approvers, and elevated group combinations.
        l_groups := SYS.ODCIVARCHAR2LIST(
            'jit_dba',
            'jit_dba_approvers',
            'jit_dba_elevated',
            'inf_idcsuser_admin',
            'inf_idcsuser_admin_approvers',
            'inf_idcsuser_admin_elevated'
        );

        RETURN l_groups;
    END get_user_groups;

    ---------------------------------------------------------------------------
    -- add_group_member
    -- Simulates adding a user to an IDCS group.
    -- In production: PATCH {stripe_url}/admin/v1/Groups/{group_id} with
    -- Operations: [{"op":"add","path":"members","value":[{"value":"{user_id}"}]}]
    ---------------------------------------------------------------------------
    PROCEDURE add_group_member (
        p_tenancy_id IN NUMBER,
        p_group_name IN VARCHAR2,
        p_username   IN VARCHAR2
    )
    IS
    BEGIN
        DBMS_OUTPUT.PUT_LINE('[PKG_IDCS] add_group_member: SIMULATED - Adding user "' || p_username || '" to group "' || p_group_name || '" in tenancy ' || p_tenancy_id);
        -- No-op in simulation.
        -- In production: obtain token, resolve group_id, PATCH members.
    END add_group_member;

    ---------------------------------------------------------------------------
    -- remove_group_member
    -- Simulates removing a user from an IDCS group.
    -- In production: PATCH {stripe_url}/admin/v1/Groups/{group_id} with
    -- Operations: [{"op":"remove","path":"members[value eq \"{user_id}\"]"}]
    ---------------------------------------------------------------------------
    PROCEDURE remove_group_member (
        p_tenancy_id IN NUMBER,
        p_group_name IN VARCHAR2,
        p_username   IN VARCHAR2
    )
    IS
    BEGIN
        DBMS_OUTPUT.PUT_LINE('[PKG_IDCS] remove_group_member: SIMULATED - Removing user "' || p_username || '" from group "' || p_group_name || '" in tenancy ' || p_tenancy_id);
        -- No-op in simulation.
        -- In production: obtain token, resolve group_id, PATCH to remove member.
    END remove_group_member;

    ---------------------------------------------------------------------------
    -- set_user_password
    -- Simulates setting a user's password in IDCS.
    -- In production: PATCH {stripe_url}/admin/v1/Users/{user_id} with
    -- Operations: [{"op":"replace","path":"password","value":"{new_password}"}]
    ---------------------------------------------------------------------------
    PROCEDURE set_user_password (
        p_tenancy_id   IN NUMBER,
        p_username     IN VARCHAR2,
        p_new_password IN VARCHAR2
    )
    IS
    BEGIN
        DBMS_OUTPUT.PUT_LINE('[PKG_IDCS] set_user_password: SIMULATED - Setting password for user "' || p_username || '" in tenancy ' || p_tenancy_id || ' (password length: ' || LENGTH(p_new_password) || ')');
        -- No-op in simulation.
        -- In production: obtain token, resolve user_id, PATCH password.
    END set_user_password;

    ---------------------------------------------------------------------------
    -- get_group_members
    -- Simulates fetching all members of an IDCS group.
    -- In production: GET {stripe_url}/admin/v1/Groups/{group_id}?attributes=members
    -- with Bearer token, parse JSON members array, return collection of usernames.
    ---------------------------------------------------------------------------
    FUNCTION get_group_members (
        p_tenancy_id IN NUMBER,
        p_group_name IN VARCHAR2
    ) RETURN SYS.ODCIVARCHAR2LIST
    IS
        l_members SYS.ODCIVARCHAR2LIST;
    BEGIN
        DBMS_OUTPUT.PUT_LINE('[PKG_IDCS] get_group_members: Simulated members for group "' || p_group_name || '" in tenancy ' || p_tenancy_id);

        -- Return a hardcoded list of sample usernames.
        l_members := SYS.ODCIVARCHAR2LIST(
            'john.smith@example.com',
            'jane.doe@example.com',
            'bob.jones@example.com'
        );

        RETURN l_members;
    END get_group_members;

END pkg_idcs;
/
