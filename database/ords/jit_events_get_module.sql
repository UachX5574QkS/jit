-- ORDS Handler: GET /jit/v1/events/
-- Returns all break-glass events for the authenticated user (as owner or approver).
-- Calls PKG_BREAK_GLASS.get_user_events and serializes the result cursor as JSON.
-- Requirements: 12.1, 14.7
--
-- NOTE: The jit_events module and '.' template are defined in jit_events_module.sql.
-- This script adds the GET handler to that existing template.

BEGIN
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'jit_events',
        p_pattern        => '.',
        p_method         => 'GET',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_cursor    SYS_REFCURSOR;
    l_user      VARCHAR2(200) := NVL(:current_user, V('APP_USER'));
    l_event_id           NUMBER;
    l_event_type         VARCHAR2(20);
    l_target_identifier  VARCHAR2(200);
    l_requesting_user    VARCHAR2(200);
    l_approver_username  VARCHAR2(200);
    l_status             VARCHAR2(30);
    l_start_time         TIMESTAMP WITH TIME ZONE;
    l_end_time           TIMESTAMP WITH TIME ZONE;
    l_ticket_reference   VARCHAR2(100);
    l_description        VARCHAR2(500);
    l_tenancy_id         NUMBER;
    l_created_at         TIMESTAMP WITH TIME ZONE;
    l_updated_at         TIMESTAMP WITH TIME ZONE;
BEGIN
    IF l_user IS NULL THEN
        OWA_UTIL.status_line(401, 'Unauthorized');
        APEX_JSON.open_object;
        APEX_JSON.write('error', 'No authenticated session found');
        APEX_JSON.close_object;
        RETURN;
    END IF;

    l_cursor := pkg_break_glass.get_user_events(p_username => l_user);

    APEX_JSON.open_object;
    APEX_JSON.open_array('items');

    LOOP
        FETCH l_cursor INTO
            l_event_id, l_event_type, l_target_identifier, l_requesting_user,
            l_approver_username, l_status, l_start_time, l_end_time,
            l_ticket_reference, l_description, l_tenancy_id,
            l_created_at, l_updated_at;
        EXIT WHEN l_cursor%NOTFOUND;

        APEX_JSON.open_object;
        APEX_JSON.write('event_id',           l_event_id);
        APEX_JSON.write('event_type',         l_event_type);
        APEX_JSON.write('target_identifier',  l_target_identifier);
        APEX_JSON.write('requesting_user',    l_requesting_user);
        APEX_JSON.write('approver_username',  l_approver_username);
        APEX_JSON.write('status',             l_status);
        APEX_JSON.write('start_time',         TO_CHAR(l_start_time, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'));
        APEX_JSON.write('end_time',           TO_CHAR(l_end_time, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'));
        APEX_JSON.write('ticket_reference',   l_ticket_reference);
        APEX_JSON.write('description',        l_description);
        APEX_JSON.write('created_at',         TO_CHAR(l_created_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'));
        APEX_JSON.write('updated_at',         TO_CHAR(l_updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'));
        APEX_JSON.close_object;
    END LOOP;

    CLOSE l_cursor;

    APEX_JSON.close_array;
    APEX_JSON.close_object;
END;
]',
        p_comments       => 'GET handler - returns all events for the authenticated user'
    );

    COMMIT;
END;
/
