/*
** jit_auth_module.sql
** ORDS REST Module: jit_auth
** Base Path: /jit/v1/auth/
**
** Provides the authenticated user's IDCS group memberships.
** Requirements: 1.1, 14.2
*/

BEGIN
    ORDS.DEFINE_MODULE(
        p_module_name    => 'jit_auth',
        p_base_path      => '/jit/v1/auth/',
        p_items_per_page => 0,
        p_status         => 'PUBLISHED',
        p_comments       => 'Authentication info and IDCS group retrieval'
    );

    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'jit_auth',
        p_pattern        => '.',
        p_comments       => 'Returns IDCS groups for the authenticated session user'
    );

    ORDS.DEFINE_HANDLER(
        p_module_name    => 'jit_auth',
        p_pattern        => '.',
        p_method         => 'GET',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_username    VARCHAR2(200);
    l_groups      SYS.ODCIVARCHAR2LIST;
    l_tenancy_id  NUMBER := 1; -- Default tenancy
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

    -- Retrieve the user's IDCS groups
    l_groups := PKG_IDCS.GET_USER_GROUPS(
        p_tenancy_id => l_tenancy_id,
        p_username   => l_username
    );

    -- Build JSON response
    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.OPEN_ARRAY('groups');
    IF l_groups IS NOT NULL AND l_groups.COUNT > 0 THEN
        FOR i IN 1 .. l_groups.COUNT LOOP
            APEX_JSON.WRITE(l_groups(i));
        END LOOP;
    END IF;
    APEX_JSON.CLOSE_ARRAY;
    APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'GET handler - returns user IDCS group memberships as JSON'
    );

    COMMIT;
END;
/
