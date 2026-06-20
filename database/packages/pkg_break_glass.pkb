CREATE OR REPLACE PACKAGE BODY pkg_break_glass AS
    /*
    ** PKG_BREAK_GLASS (Body)
    ** Business logic for break-glass access requests: request validation,
    ** event creation, status transitions, and authorization checks.
    */

    ----------------------------------------------------------------------------
    -- validate_request
    ----------------------------------------------------------------------------
    PROCEDURE validate_request(
        p_event_type       IN VARCHAR2,
        p_start_time       IN TIMESTAMP WITH TIME ZONE,
        p_end_time         IN TIMESTAMP WITH TIME ZONE,
        p_ticket_reference IN VARCHAR2,
        p_description      IN VARCHAR2
    ) IS
        l_now              TIMESTAMP WITH TIME ZONE := SYSTIMESTAMP;
        l_ticket_trimmed   VARCHAR2(32767);
    BEGIN
        -- Validate start_time is not in the past
        IF p_start_time < l_now THEN
            RAISE_APPLICATION_ERROR(-20001,
                'start_time must not be in the past');
        END IF;

        -- Validate start_time < end_time
        IF p_start_time >= p_end_time THEN
            RAISE_APPLICATION_ERROR(-20001,
                'start_time must be before end_time');
        END IF;

        -- For GROUP type: duration must not exceed 72 hours
        IF UPPER(p_event_type) = 'GROUP' THEN
            IF p_end_time - p_start_time > INTERVAL '72' HOUR THEN
                RAISE_APPLICATION_ERROR(-20001,
                    'Duration must not exceed 72 hours for GROUP event type');
            END IF;
        END IF;

        -- Validate ticket_reference: trimmed length between 1 and 100
        l_ticket_trimmed := TRIM(p_ticket_reference);
        IF l_ticket_trimmed IS NULL OR LENGTH(l_ticket_trimmed) < 1 THEN
            RAISE_APPLICATION_ERROR(-20001,
                'ticket_reference must not be empty after trimming');
        END IF;
        IF LENGTH(l_ticket_trimmed) > 100 THEN
            RAISE_APPLICATION_ERROR(-20001,
                'ticket_reference must not exceed 100 characters after trimming');
        END IF;

        -- Validate description: length between 1 and 500
        IF p_description IS NULL OR LENGTH(p_description) < 1 THEN
            RAISE_APPLICATION_ERROR(-20001,
                'description must not be empty');
        END IF;
        IF LENGTH(p_description) > 500 THEN
            RAISE_APPLICATION_ERROR(-20001,
                'description must not exceed 500 characters');
        END IF;
    END validate_request;

    ----------------------------------------------------------------------------
    -- create_event
    ----------------------------------------------------------------------------
    FUNCTION create_event(
        p_event_type        IN VARCHAR2,
        p_target_identifier IN VARCHAR2,
        p_requesting_user   IN VARCHAR2,
        p_approver_username IN VARCHAR2,
        p_start_time        IN TIMESTAMP WITH TIME ZONE,
        p_end_time          IN TIMESTAMP WITH TIME ZONE,
        p_ticket_reference  IN VARCHAR2,
        p_description       IN VARCHAR2,
        p_tenancy_id        IN NUMBER
    ) RETURN NUMBER IS
        l_event_id NUMBER;
    BEGIN
        -- Insert the break-glass event record
        INSERT INTO break_glass_event (
            event_type,
            target_identifier,
            requesting_user,
            approver_username,
            status,
            start_time,
            end_time,
            ticket_reference,
            description,
            tenancy_id
        ) VALUES (
            p_event_type,
            p_target_identifier,
            p_requesting_user,
            p_approver_username,
            'started',
            p_start_time,
            p_end_time,
            p_ticket_reference,
            p_description,
            p_tenancy_id
        )
        RETURNING event_id INTO l_event_id;

        -- Insert initial status history record
        INSERT INTO event_status_history (
            event_id,
            from_status,
            to_status,
            changed_by,
            change_reason,
            changed_at
        ) VALUES (
            l_event_id,
            NULL,
            'started',
            p_requesting_user,
            'Event created',
            SYSTIMESTAMP
        );

        RETURN l_event_id;
    END create_event;

    ----------------------------------------------------------------------------
    -- update_event_status
    ----------------------------------------------------------------------------
    PROCEDURE update_event_status(
        p_event_id      IN NUMBER,
        p_new_status    IN VARCHAR2,
        p_changed_by    IN VARCHAR2,
        p_change_reason IN VARCHAR2 DEFAULT NULL
    ) IS
        l_current_status VARCHAR2(30);
    BEGIN
        -- Retrieve the current status
        SELECT status
          INTO l_current_status
          FROM break_glass_event
         WHERE event_id = p_event_id;

        -- Update the event status and timestamp
        UPDATE break_glass_event
           SET status     = p_new_status,
               updated_at = SYSTIMESTAMP
         WHERE event_id = p_event_id;

        -- Insert status history record
        INSERT INTO event_status_history (
            event_id,
            from_status,
            to_status,
            changed_by,
            change_reason,
            changed_at
        ) VALUES (
            p_event_id,
            l_current_status,
            p_new_status,
            p_changed_by,
            p_change_reason,
            SYSTIMESTAMP
        );
    END update_event_status;

    ----------------------------------------------------------------------------
    -- get_user_events
    ----------------------------------------------------------------------------
    FUNCTION get_user_events(
        p_username IN VARCHAR2
    ) RETURN SYS_REFCURSOR IS
        l_cursor SYS_REFCURSOR;
    BEGIN
        OPEN l_cursor FOR
            SELECT event_id,
                   event_type,
                   target_identifier,
                   requesting_user,
                   approver_username,
                   status,
                   start_time,
                   end_time,
                   ticket_reference,
                   description,
                   tenancy_id,
                   workflow_instance_id,
                   approval_comment,
                   created_at,
                   updated_at
              FROM break_glass_event
             WHERE requesting_user = p_username
                OR approver_username = p_username
             ORDER BY created_at DESC;

        RETURN l_cursor;
    END get_user_events;

    ----------------------------------------------------------------------------
    -- get_event_detail
    ----------------------------------------------------------------------------
    FUNCTION get_event_detail(
        p_event_id IN NUMBER
    ) RETURN SYS_REFCURSOR IS
        l_cursor SYS_REFCURSOR;
    BEGIN
        OPEN l_cursor FOR
            SELECT event_id,
                   event_type,
                   target_identifier,
                   requesting_user,
                   approver_username,
                   status,
                   start_time,
                   end_time,
                   ticket_reference,
                   description,
                   tenancy_id,
                   workflow_instance_id,
                   approval_comment,
                   created_at,
                   updated_at
              FROM break_glass_event
             WHERE event_id = p_event_id;

        RETURN l_cursor;
    END get_event_detail;

    ----------------------------------------------------------------------------
    -- authorize_user_for_event
    ----------------------------------------------------------------------------
    PROCEDURE authorize_user_for_event(
        p_event_id IN NUMBER,
        p_username IN VARCHAR2
    ) IS
        l_requesting_user   VARCHAR2(200);
        l_approver_username VARCHAR2(200);
    BEGIN
        -- Retrieve the owner and approver for the event
        SELECT requesting_user, approver_username
          INTO l_requesting_user, l_approver_username
          FROM break_glass_event
         WHERE event_id = p_event_id;

        -- Check if the user is authorized
        IF p_username != l_requesting_user
           AND (l_approver_username IS NULL OR p_username != l_approver_username)
        THEN
            RAISE_APPLICATION_ERROR(-20002,
                'User is not authorized for this event');
        END IF;
    END authorize_user_for_event;

END pkg_break_glass;
/
