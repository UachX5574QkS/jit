/*
** jit_targets_approvers_module.sql
** ORDS REST Module: jit_targets (approvers endpoint)
** Endpoint: GET /jit/v1/targets/:type/:name/approvers
**
** Returns the list of approvers for a given target, excluding the requesting user.
** Requirements: 5.1, 10.2
*/

BEGIN
    ---------------------------------------------------------------------------
    -- Template: GET /jit/v1/targets/:type/:name/approvers
    -- :type = 'group' or 'password'
    -- :name = the target base name
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'jit_targets',
        p_pattern        => ':type/:name/approvers',
        p_comments       => 'Returns approvers for the specified target, excluding the requesting user'
    );

    ORDS.DEFINE_HANDLER(
        p_module_name    => 'jit_targets',
        p_pattern        => ':type/:name/approvers',
        p_method         => 'GET',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_username        VARCHAR2(200);
    l_tenancy_id      NUMBER := 1; -- Default tenancy
    l_type            VARCHAR2(50);
    l_name            VARCHAR2(400);
    l_approvers_group VARCHAR2(400);
    l_members         SYS.ODCIVARCHAR2LIST;
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

    l_type := LOWER(:type);
    l_name := LOWER(:name);

    -- Determine the approvers group name based on target type
    IF l_type = 'group' THEN
        l_approvers_group := 'jit_' || l_name || '_approvers';
    ELSIF l_type = 'password' THEN
        l_approvers_group := 'inf_idcsuser_' || l_name || '_approvers';
    ELSE
        OWA_UTIL.STATUS_LINE(400, 'Bad Request');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.OPEN_OBJECT('error');
        APEX_JSON.WRITE('code', 'VALIDATION_FAILED');
        APEX_JSON.WRITE('message', 'Invalid target type. Must be "group" or "password".');
        APEX_JSON.CLOSE_OBJECT;
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Get members of the approvers group
    l_members := PKG_IDCS.GET_GROUP_MEMBERS(
        p_tenancy_id => l_tenancy_id,
        p_group_name => l_approvers_group
    );

    -- Build JSON response, excluding the requesting user
    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.OPEN_ARRAY('approvers');

    IF l_members IS NOT NULL AND l_members.COUNT > 0 THEN
        FOR i IN 1 .. l_members.COUNT LOOP
            -- Each member entry is formatted as "username|display_name|email"
            -- If PKG_IDCS returns just usernames, adapt accordingly
            DECLARE
                l_member VARCHAR2(400) := l_members(i);
                l_sep1   PLS_INTEGER;
                l_sep2   PLS_INTEGER;
                l_uname  VARCHAR2(200);
                l_dname  VARCHAR2(200);
                l_email  VARCHAR2(200);
            BEGIN
                -- Parse pipe-delimited member string: username|display_name|email
                l_sep1 := INSTR(l_member, '|', 1, 1);
                l_sep2 := INSTR(l_member, '|', 1, 2);

                IF l_sep1 > 0 AND l_sep2 > 0 THEN
                    l_uname := SUBSTR(l_member, 1, l_sep1 - 1);
                    l_dname := SUBSTR(l_member, l_sep1 + 1, l_sep2 - l_sep1 - 1);
                    l_email := SUBSTR(l_member, l_sep2 + 1);
                ELSE
                    -- Fallback: treat entire string as username
                    l_uname := l_member;
                    l_dname := l_member;
                    l_email := l_member || '@example.com';
                END IF;

                -- Exclude the requesting user from the approvers list
                IF LOWER(l_uname) != LOWER(l_username) THEN
                    APEX_JSON.OPEN_OBJECT;
                    APEX_JSON.WRITE('username', l_uname);
                    APEX_JSON.WRITE('display_name', l_dname);
                    APEX_JSON.WRITE('email', l_email);
                    APEX_JSON.CLOSE_OBJECT;
                END IF;
            END;
        END LOOP;
    END IF;

    APEX_JSON.CLOSE_ARRAY;
    APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'GET handler - returns approvers for a target excluding the requesting user'
    );

    COMMIT;
END;
/
