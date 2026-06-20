/*
** jit_events_module.sql
** ORDS REST Module: jit_events
** Base Path: /jit/v1/events/
**
** Handles break-glass event creation (POST) and retrieval (GET).
** Requirements: 4.4, 9.6, 12.1, 14.4
*/

BEGIN
    ORDS.DEFINE_MODULE(
        p_module_name    => 'jit_events',
        p_base_path      => '/jit/v1/events/',
        p_items_per_page => 0,
        p_status         => 'PUBLISHED',
        p_comments       => 'Break-glass event CRUD'
    );

    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'jit_events',
        p_pattern        => '.',
        p_comments       => 'Create and list break-glass events'
    );

    ---------------------------------------------------------------------------
    -- POST /jit/v1/events/
    -- Creates a new break-glass event after validation
    ---------------------------------------------------------------------------
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'jit_events',
        p_pattern        => '.',
        p_method         => 'POST',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_username          VARCHAR2(200);
    l_tenancy_id        NUMBER := 1; -- Default tenancy
    l_event_id          NUMBER;
    l_body              CLOB;
    l_event_type        VARCHAR2(20);
    l_target_identifier VARCHAR2(200);
    l_start_time        TIMESTAMP WITH TIME ZONE;
    l_end_time          TIMESTAMP WITH TIME ZONE;
    l_ticket_reference  VARCHAR2(100);
    l_description       VARCHAR2(500);
    l_approver_username VARCHAR2(200);
    l_created_at        TIMESTAMP WITH TIME ZONE;
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

    -- Parse JSON request body
    l_body := :body_text;
    APEX_JSON.PARSE(l_body);

    l_event_type        := APEX_JSON.GET_VARCHAR2(p_path => 'event_type');
    l_target_identifier := APEX_JSON.GET_VARCHAR2(p_path => 'target_identifier');
    l_start_time        := TO_TIMESTAMP_TZ(
                               APEX_JSON.GET_VARCHAR2(p_path => 'start_time'),
                               'YYYY-MM-DD"T"HH24:MI:SS.FFTZHTZM'
                           );
    l_end_time          := TO_TIMESTAMP_TZ(
                               APEX_JSON.GET_VARCHAR2(p_path => 'end_time'),
                               'YYYY-MM-DD"T"HH24:MI:SS.FFTZHTZM'
                           );
    l_ticket_reference  := APEX_JSON.GET_VARCHAR2(p_path => 'ticket_reference');
    l_description       := APEX_JSON.GET_VARCHAR2(p_path => 'description');
    l_approver_username := APEX_JSON.GET_VARCHAR2(p_path => 'approver_username');

    -- Validate the request
    BEGIN
        PKG_BREAK_GLASS.VALIDATE_REQUEST(
            p_event_type       => l_event_type,
            p_start_time       => l_start_time,
            p_end_time         => l_end_time,
            p_ticket_reference => l_ticket_reference,
            p_description      => l_description
        );
    EXCEPTION
        WHEN PKG_BREAK_GLASS.e_validation_failed THEN
            OWA_UTIL.STATUS_LINE(400, 'Bad Request');
            APEX_JSON.OPEN_OBJECT;
            APEX_JSON.OPEN_OBJECT('error');
            APEX_JSON.WRITE('code', 'VALIDATION_FAILED');
            APEX_JSON.WRITE('message', SQLERRM);
            APEX_JSON.CLOSE_OBJECT;
            APEX_JSON.CLOSE_OBJECT;
            RETURN;
    END;

    -- Create the event
    l_event_id := PKG_BREAK_GLASS.CREATE_EVENT(
        p_event_type        => l_event_type,
        p_target_identifier => l_target_identifier,
        p_requesting_user   => l_username,
        p_approver_username => l_approver_username,
        p_start_time        => l_start_time,
        p_end_time          => l_end_time,
        p_ticket_reference  => l_ticket_reference,
        p_description       => l_description,
        p_tenancy_id        => l_tenancy_id
    );

    -- Retrieve created_at for response
    SELECT created_at
      INTO l_created_at
      FROM break_glass_event
     WHERE event_id = l_event_id;

    -- Return 201 Created response
    OWA_UTIL.STATUS_LINE(201, 'Created');
    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.WRITE('event_id', l_event_id);
    APEX_JSON.WRITE('status', 'started');
    APEX_JSON.WRITE('created_at', TO_CHAR(l_created_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'));
    APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'POST handler - validates and creates a break-glass event'
    );

    -- NOTE: GET handler for this template is defined in jit_events_get_module.sql
    -- It calls PKG_BREAK_GLASS.get_user_events and returns the events array.

    COMMIT;
END;
/
