/*
** jit_targets_module.sql
** ORDS REST Module: jit_targets
** Base Path: /jit/v1/targets/
**
** Discovers valid group and password targets based on the authenticated
** user's IDCS group memberships using combination detection logic.
** Requirements: 3.1, 3.2, 8.1, 8.2
*/

BEGIN
    ORDS.DEFINE_MODULE(
        p_module_name    => 'jit_targets',
        p_base_path      => '/jit/v1/targets/',
        p_items_per_page => 0,
        p_status         => 'PUBLISHED',
        p_comments       => 'Target discovery - groups and password targets'
    );

    ---------------------------------------------------------------------------
    -- Template: GET /jit/v1/targets/
    -- Returns group_targets and password_targets arrays
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'jit_targets',
        p_pattern        => '.',
        p_comments       => 'Returns discoverable group and password targets for the session user'
    );

    ORDS.DEFINE_HANDLER(
        p_module_name    => 'jit_targets',
        p_pattern        => '.',
        p_method         => 'GET',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_username    VARCHAR2(200);
    l_groups      SYS.ODCIVARCHAR2LIST;
    l_tenancy_id  NUMBER := 1; -- Default tenancy

    -- Associative array for fast group membership lookup
    TYPE t_group_set IS TABLE OF BOOLEAN INDEX BY VARCHAR2(400);
    l_group_set   t_group_set;

    -- Target detection variables
    l_base_name   VARCHAR2(400);
    l_found_group_targets   BOOLEAN := FALSE;
    l_found_pwd_targets     BOOLEAN := FALSE;

    -- Group target prefixes/suffixes
    c_grp_prefix          CONSTANT VARCHAR2(10)  := 'jit_';
    c_grp_approvers_sfx   CONSTANT VARCHAR2(20)  := '_approvers';
    c_grp_elevated_sfx    CONSTANT VARCHAR2(20)  := '_elevated';

    -- Password target prefixes/suffixes
    c_pwd_prefix          CONSTANT VARCHAR2(20)  := 'inf_idcsuser_';
    c_pwd_approvers_sfx   CONSTANT VARCHAR2(20)  := '_approvers';
    c_pwd_elevated_sfx    CONSTANT VARCHAR2(20)  := '_elevated';

    -- Track already-emitted targets to avoid duplicates
    TYPE t_name_set IS TABLE OF BOOLEAN INDEX BY VARCHAR2(400);
    l_emitted_grp  t_name_set;
    l_emitted_pwd  t_name_set;
BEGIN
    -- Get the authenticated APEX session user
    l_username := NVL(:current_user, V('APP_USER'));

    IF l_username IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.OPEN_OBJECT('error');
        APEX_JSON.WRITE('code', 'AUTH_FAILED');
        APEX_JSON.WRITE('message', 'No authenticated session found');
        APEX_JSON.CLOSE_OBJECT;
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Retrieve user's IDCS groups
    l_groups := PKG_IDCS.GET_USER_GROUPS(
        p_tenancy_id => l_tenancy_id,
        p_username   => l_username
    );

    -- Build lookup set for O(1) membership checks
    IF l_groups IS NOT NULL AND l_groups.COUNT > 0 THEN
        FOR i IN 1 .. l_groups.COUNT LOOP
            l_group_set(LOWER(l_groups(i))) := TRUE;
        END LOOP;
    END IF;

    -- Begin JSON response
    APEX_JSON.OPEN_OBJECT;

    ---------------------------------------------------------------------------
    -- Detect Group Targets
    -- Pattern: jit_<name>, jit_<name>_approvers, jit_<name>_elevated
    -- User must be a member of the base group jit_<name>
    ---------------------------------------------------------------------------
    APEX_JSON.OPEN_ARRAY('group_targets');

    IF l_groups IS NOT NULL AND l_groups.COUNT > 0 THEN
        FOR i IN 1 .. l_groups.COUNT LOOP
            DECLARE
                l_grp_lower VARCHAR2(400) := LOWER(l_groups(i));
            BEGIN
                -- Check if this group matches the base pattern: starts with 'jit_'
                -- and does NOT end with '_approvers' or '_elevated'
                IF l_grp_lower LIKE c_grp_prefix || '%'
                   AND l_grp_lower NOT LIKE '%' || c_grp_approvers_sfx
                   AND l_grp_lower NOT LIKE '%' || c_grp_elevated_sfx
                THEN
                    -- Extract base name (everything after 'jit_')
                    l_base_name := SUBSTR(l_grp_lower, LENGTH(c_grp_prefix) + 1);

                    -- Check that the approvers and elevated groups also exist
                    IF l_group_set.EXISTS(c_grp_prefix || l_base_name || c_grp_approvers_sfx)
                       AND l_group_set.EXISTS(c_grp_prefix || l_base_name || c_grp_elevated_sfx)
                       AND NOT l_emitted_grp.EXISTS(l_base_name)
                    THEN
                        -- User is member of base group (since we found it in their groups)
                        APEX_JSON.OPEN_OBJECT;
                        APEX_JSON.WRITE('group_name', l_base_name);
                        APEX_JSON.WRITE('elevated_group', c_grp_prefix || l_base_name || c_grp_elevated_sfx);
                        APEX_JSON.WRITE('approvers_group', c_grp_prefix || l_base_name || c_grp_approvers_sfx);
                        APEX_JSON.CLOSE_OBJECT;
                        l_emitted_grp(l_base_name) := TRUE;
                    END IF;
                END IF;
            END;
        END LOOP;
    END IF;

    APEX_JSON.CLOSE_ARRAY;

    ---------------------------------------------------------------------------
    -- Detect Password Targets
    -- Pattern: inf_idcsuser_<name>, inf_idcsuser_<name>_approvers, inf_idcsuser_<name>_elevated
    -- User must be a member of the base group inf_idcsuser_<name>
    ---------------------------------------------------------------------------
    APEX_JSON.OPEN_ARRAY('password_targets');

    IF l_groups IS NOT NULL AND l_groups.COUNT > 0 THEN
        FOR i IN 1 .. l_groups.COUNT LOOP
            DECLARE
                l_grp_lower VARCHAR2(400) := LOWER(l_groups(i));
            BEGIN
                -- Check if this group matches the base pattern: starts with 'inf_idcsuser_'
                -- and does NOT end with '_approvers' or '_elevated'
                IF l_grp_lower LIKE c_pwd_prefix || '%'
                   AND l_grp_lower NOT LIKE '%' || c_pwd_approvers_sfx
                   AND l_grp_lower NOT LIKE '%' || c_pwd_elevated_sfx
                THEN
                    -- Extract base name (everything after 'inf_idcsuser_')
                    l_base_name := SUBSTR(l_grp_lower, LENGTH(c_pwd_prefix) + 1);

                    -- Check that the approvers and elevated groups also exist
                    IF l_group_set.EXISTS(c_pwd_prefix || l_base_name || c_pwd_approvers_sfx)
                       AND l_group_set.EXISTS(c_pwd_prefix || l_base_name || c_pwd_elevated_sfx)
                       AND NOT l_emitted_pwd.EXISTS(l_base_name)
                    THEN
                        -- User is member of base group (since we found it in their groups)
                        APEX_JSON.OPEN_OBJECT;
                        APEX_JSON.WRITE('user_name', l_base_name);
                        APEX_JSON.WRITE('elevated_group', c_pwd_prefix || l_base_name || c_pwd_elevated_sfx);
                        APEX_JSON.WRITE('approvers_group', c_pwd_prefix || l_base_name || c_pwd_approvers_sfx);
                        APEX_JSON.CLOSE_OBJECT;
                        l_emitted_pwd(l_base_name) := TRUE;
                    END IF;
                END IF;
            END;
        END LOOP;
    END IF;

    APEX_JSON.CLOSE_ARRAY;

    APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'GET handler - discovers group and password targets via combination detection'
    );

    COMMIT;
END;
/
