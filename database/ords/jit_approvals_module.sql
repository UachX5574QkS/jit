/*
** jit_approvals_module.sql
** ORDS REST Module: jit_approvals
** Base Path: /jit/v1/approvals/
**
** PUT /:event_id handler: process approve/deny actions
** GET / handler: list all events where current user is the approver
** Requirements: 6.2, 6.3, 10.4, 10.5, 17.1, 17.2
*/

BEGIN
    ORDS.DEFINE_MODULE(
        p_module_name    => 'jit_approvals',
        p_base_path      => '/jit/v1/approvals/',
        p_items_per_page => 0,
        p_status         => 'PUBLISHED',
        p_comments       => 'Approval actions for break-glass events'
    );

    ---------------------------------------------------------------------------
    -- Template: / (list approvals for current user)
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'jit_approvals',
        p_pattern        => '.',
        p_comments       => 'List events assigned to current user as approver'
    );

    -- GET / handler: return events where current user is the approver
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'jit_approvals',
        p_pattern        => '.',
        p_method         => 'GET',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user VARCHAR2(200) := NVL(:current_user, V('APP_USER'));
BEGIN
    IF l_user IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'No authenticated session found');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.OPEN_ARRAY('items');

    FOR rec IN (
        SELECT event_id, event_type, target_identifier, requesting_user,
               status, start_time, end_time, ticket_reference, description,
               created_at, updated_at
          FROM break_glass_event
         WHERE approver_username = l_user
         ORDER BY created_at DESC
    ) LOOP
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('event_id',           rec.event_id);
        APEX_JSON.WRITE('event_type',         rec.event_type);
        APEX_JSON.WRITE('target_identifier',  rec.target_identifier);
        APEX_JSON.WRITE('requesting_user',    rec.requesting_user);
        APEX_JSON.WRITE('status',             rec.status);
        APEX_JSON.WRITE('start_time',         TO_CHAR(rec.start_time, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'));
        APEX_JSON.WRITE('end_time',           TO_CHAR(rec.end_time, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'));
        APEX_JSON.WRITE('ticket_reference',   rec.ticket_reference);
        APEX_JSON.WRITE('description',        rec.description);
        APEX_JSON.WRITE('created_at',         TO_CHAR(rec.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'));
        APEX_JSON.WRITE('updated_at',         TO_CHAR(rec.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'));
        APEX_JSON.CLOSE_OBJECT;
    END LOOP;

    APEX_JSON.CLOSE_ARRAY;
    APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'GET handler - returns events where user is the designated approver'
    );

    ---------------------------------------------------------------------------
    -- Template: /:event_id (approve/deny a specific event)
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'jit_approvals',
        p_pattern        => ':event_id',
        p_comments       => 'Approve or deny a break-glass event'
    );

    -- PUT /:event_id handler: approve or deny an event
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'jit_approvals',
        p_pattern        => ':event_id',
        p_method         => 'PUT',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user             VARCHAR2(200) := NVL(:current_user, V('APP_USER'));
    l_event_id         NUMBER := :event_id;
    l_action           VARCHAR2(20);
    l_comment          VARCHAR2(1000);
    l_new_status       VARCHAR2(30);
    l_approver         VARCHAR2(200);
    l_current_status   VARCHAR2(30);
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
    l_action  := UPPER(APEX_JSON.GET_VARCHAR2(p_path => 'action'));
    l_comment := APEX_JSON.GET_VARCHAR2(p_path => 'comment');

    -- Validate action
    IF l_action NOT IN ('APPROVE', 'DENY') THEN
        OWA_UTIL.STATUS_LINE(400, 'Bad Request');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'action must be APPROVE or DENY');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Fetch event to validate approver authorization
    BEGIN
        SELECT approver_username, status
          INTO l_approver, l_current_status
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

    -- Authorize: current user must be the designated approver
    IF l_approver IS NULL OR UPPER(l_approver) != UPPER(l_user) THEN
        OWA_UTIL.STATUS_LINE(403, 'Forbidden');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'You are not the designated approver for this event');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Validate current status allows approval action
    IF l_current_status != 'approval_pending' THEN
        OWA_UTIL.STATUS_LINE(400, 'Bad Request');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'Event is not in approval_pending status. Current status: ' || l_current_status);
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Determine new status based on action
    IF l_action = 'APPROVE' THEN
        l_new_status := 'approved';
    ELSE
        l_new_status := 'denied';
    END IF;

    -- Update event status
    PKG_BREAK_GLASS.UPDATE_EVENT_STATUS(
        p_event_id      => l_event_id,
        p_new_status    => l_new_status,
        p_changed_by    => l_user,
        p_change_reason => l_comment
    );

    -- Store the approval comment on the event record
    IF l_comment IS NOT NULL THEN
        UPDATE break_glass_event
           SET approval_comment = l_comment,
               updated_at       = SYSTIMESTAMP
         WHERE event_id = l_event_id;
    END IF;

    -- Return success response
    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.WRITE('event_id',    l_event_id);
    APEX_JSON.WRITE('status',      l_new_status);
    APEX_JSON.WRITE('actioned_at', TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'));
    APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'PUT handler - approve or deny a break-glass event'
    );

    COMMIT;
END;
/
