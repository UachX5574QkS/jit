/*
** jit_password_module.sql
** ORDS REST Module: jit_password
** Base Path: /jit/v1/password/
**
** POST /reveal handler: validates preconditions, generates password, sets via IDCS,
** schedules reset, and returns the temporary password.
** Requirements: 11.1, 11.2, 11.3, 11.4, 14.3, 14.6
*/

BEGIN
    ORDS.DEFINE_MODULE(
        p_module_name    => 'jit_password',
        p_base_path      => '/jit/v1/password/',
        p_items_per_page => 0,
        p_status         => 'PUBLISHED',
        p_comments       => 'Password reveal operations for break-glass events'
    );

    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'jit_password',
        p_pattern        => 'reveal',
        p_comments       => 'Reveal (generate and set) password for an approved event'
    );

    -- POST /reveal handler
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'jit_password',
        p_pattern        => 'reveal',
        p_method         => 'POST',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user             VARCHAR2(200) := NVL(:current_user, V('APP_USER'));
    l_event_id         NUMBER;
    l_event_type       VARCHAR2(20);
    l_status           VARCHAR2(30);
    l_start_time       TIMESTAMP WITH TIME ZONE;
    l_end_time         TIMESTAMP WITH TIME ZONE;
    l_target_id        VARCHAR2(200);
    l_tenancy_id       NUMBER;
    l_password         VARCHAR2(200);
    l_now              TIMESTAMP WITH TIME ZONE := SYSTIMESTAMP;
    l_body             CLOB;
BEGIN
    IF l_user IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'No authenticated session found');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Parse request body
    l_body := :body_text;
    APEX_JSON.PARSE(l_body);
    l_event_id := APEX_JSON.GET_NUMBER(p_path => 'event_id');

    IF l_event_id IS NULL THEN
        OWA_UTIL.STATUS_LINE(400, 'Bad Request');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'event_id is required');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Authorize: user must be the event owner or approver
    BEGIN
        PKG_BREAK_GLASS.AUTHORIZE_USER_FOR_EVENT(
            p_event_id => l_event_id,
            p_username => l_user
        );
    EXCEPTION
        WHEN PKG_BREAK_GLASS.e_authorization_failed THEN
            OWA_UTIL.STATUS_LINE(403, 'Forbidden');
            APEX_JSON.OPEN_OBJECT;
            APEX_JSON.WRITE('error', 'You are not authorized to reveal the password for this event');
            APEX_JSON.CLOSE_OBJECT;
            RETURN;
    END;

    -- Fetch event details for precondition checks
    BEGIN
        SELECT event_type, status, start_time, end_time, target_identifier, tenancy_id
          INTO l_event_type, l_status, l_start_time, l_end_time, l_target_id, l_tenancy_id
          FROM break_glass_event
         WHERE event_id = l_event_id;
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            OWA_UTIL.STATUS_LINE(404, 'Not Found');
            APEX_JSON.OPEN_OBJECT;
            APEX_JSON.WRITE('error', 'Event not found');
            APEX_JSON.CLOSE_OBJECT;
            RETURN;
    END;

    -- Precondition 1: event must be of type PASSWORD
    IF l_event_type != 'PASSWORD' THEN
        OWA_UTIL.STATUS_LINE(400, 'Bad Request');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'Password reveal is only available for PASSWORD type events');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Precondition 2: status must be 'approved' or 'password_revealed'
    IF l_status NOT IN ('approved', 'password_revealed') THEN
        OWA_UTIL.STATUS_LINE(400, 'Bad Request');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'Event status must be approved to reveal password. Current status: ' || l_status);
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Precondition 3: current time must be within the time window
    IF l_now < l_start_time OR l_now > l_end_time THEN
        OWA_UTIL.STATUS_LINE(403, 'Forbidden');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'Password can only be revealed within the approved time window');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Generate password
    l_password := PKG_PASSWORD.GENERATE_PASSWORD;

    -- Set the password in IDCS
    BEGIN
        PKG_IDCS.SET_USER_PASSWORD(
            p_tenancy_id   => l_tenancy_id,
            p_username     => l_target_id,
            p_new_password => l_password
        );
    EXCEPTION
        WHEN OTHERS THEN
            OWA_UTIL.STATUS_LINE(500, 'Internal Server Error');
            APEX_JSON.OPEN_OBJECT;
            APEX_JSON.WRITE('error', 'Failed to set password in IDCS');
            APEX_JSON.CLOSE_OBJECT;
            RETURN;
    END;

    -- Update event status to password_revealed if still approved
    IF l_status = 'approved' THEN
        PKG_BREAK_GLASS.UPDATE_EVENT_STATUS(
            p_event_id      => l_event_id,
            p_new_status    => 'password_revealed',
            p_changed_by    => l_user,
            p_change_reason => 'Password revealed by user'
        );
    END IF;

    -- Schedule the password reset (inserts log and kicks off workflow)
    PKG_PASSWORD.SCHEDULE_PASSWORD_RESET(
        p_event_id        => l_event_id,
        p_requesting_user => l_user
    );

    -- Return success response
    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.WRITE('password',           l_password);
    APEX_JSON.WRITE('expires_in_minutes', 15);
    APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'POST handler - reveal password for approved break-glass event'
    );

    COMMIT;
END;
/
