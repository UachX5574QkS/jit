CREATE OR REPLACE PACKAGE BODY pkg_notifications AS
    /*
    ** PKG_NOTIFICATIONS - Email Notification Delivery (Body)
    **
    ** Implementation of break-glass notification procedures using APEX_MAIL.SEND.
    */

    ----------------------------------------------------------------------------
    -- notify_approver
    ----------------------------------------------------------------------------
    PROCEDURE notify_approver(
        p_event_id         IN NUMBER,
        p_approver_email   IN VARCHAR2,
        p_requesting_user  IN VARCHAR2,
        p_target           IN VARCHAR2,
        p_event_type       IN VARCHAR2,
        p_start_time       IN TIMESTAMP WITH TIME ZONE,
        p_end_time         IN TIMESTAMP WITH TIME ZONE,
        p_ticket_reference IN VARCHAR2,
        p_action_url       IN VARCHAR2
    ) IS
        l_subject VARCHAR2(500);
        l_body    CLOB;
    BEGIN
        l_subject := 'Break Glass Approval Required - Event #' || p_event_id;

        l_body := 'A break-glass access request requires your approval.' || CHR(10) || CHR(10)
            || 'Event ID: ' || p_event_id || CHR(10)
            || 'Type: ' || p_event_type || CHR(10)
            || 'Requesting User: ' || p_requesting_user || CHR(10)
            || 'Target: ' || p_target || CHR(10)
            || 'Time Window: ' || TO_CHAR(p_start_time, 'YYYY-MM-DD HH24:MI:SS TZR')
            || ' to ' || TO_CHAR(p_end_time, 'YYYY-MM-DD HH24:MI:SS TZR') || CHR(10)
            || 'Ticket Reference: ' || p_ticket_reference || CHR(10) || CHR(10)
            || 'Please review and take action using the link below:' || CHR(10)
            || p_action_url || CHR(10) || CHR(10)
            || 'If you do not action this request before the time window starts, '
            || 'it will expire automatically.';

        APEX_MAIL.SEND(
            p_to   => p_approver_email,
            p_from => c_from_address,
            p_subj => l_subject,
            p_body => l_body
        );

        APEX_MAIL.PUSH_QUEUE;
    END notify_approver;

    ----------------------------------------------------------------------------
    -- notify_requester_approved
    ----------------------------------------------------------------------------
    PROCEDURE notify_requester_approved(
        p_event_id        IN NUMBER,
        p_requester_email IN VARCHAR2,
        p_target          IN VARCHAR2,
        p_event_type      IN VARCHAR2
    ) IS
        l_subject VARCHAR2(500);
        l_body    CLOB;
    BEGIN
        l_subject := 'Break Glass Request Approved - Event #' || p_event_id;

        l_body := 'Your break-glass access request has been approved.' || CHR(10) || CHR(10)
            || 'Event ID: ' || p_event_id || CHR(10)
            || 'Type: ' || p_event_type || CHR(10)
            || 'Target: ' || p_target || CHR(10) || CHR(10);

        IF p_event_type = 'GROUP' THEN
            l_body := l_body
                || 'You will be added to the elevated group at the start of your '
                || 'requested time window. Access will be automatically revoked '
                || 'at the end of the time window.';
        ELSE
            l_body := l_body
                || 'You may now reveal the password during your requested time window '
                || 'by clicking "Show Password" in the application. The password will '
                || 'be automatically reset 15 minutes after each reveal.';
        END IF;

        APEX_MAIL.SEND(
            p_to   => p_requester_email,
            p_from => c_from_address,
            p_subj => l_subject,
            p_body => l_body
        );

        APEX_MAIL.PUSH_QUEUE;
    END notify_requester_approved;

    ----------------------------------------------------------------------------
    -- notify_requester_denied
    ----------------------------------------------------------------------------
    PROCEDURE notify_requester_denied(
        p_event_id        IN NUMBER,
        p_requester_email IN VARCHAR2,
        p_target          IN VARCHAR2,
        p_event_type      IN VARCHAR2,
        p_comment         IN VARCHAR2 DEFAULT NULL
    ) IS
        l_subject VARCHAR2(500);
        l_body    CLOB;
    BEGIN
        l_subject := 'Break Glass Request Denied - Event #' || p_event_id;

        l_body := 'Your break-glass access request has been denied.' || CHR(10) || CHR(10)
            || 'Event ID: ' || p_event_id || CHR(10)
            || 'Type: ' || p_event_type || CHR(10)
            || 'Target: ' || p_target || CHR(10);

        IF p_comment IS NOT NULL THEN
            l_body := l_body || CHR(10)
                || 'Approver Comment: ' || p_comment || CHR(10);
        END IF;

        l_body := l_body || CHR(10)
            || 'If you believe this was denied in error, please contact '
            || 'the approver directly or raise a new request with additional '
            || 'justification.';

        APEX_MAIL.SEND(
            p_to   => p_requester_email,
            p_from => c_from_address,
            p_subj => l_subject,
            p_body => l_body
        );

        APEX_MAIL.PUSH_QUEUE;
    END notify_requester_denied;

    ----------------------------------------------------------------------------
    -- notify_requester_expired
    ----------------------------------------------------------------------------
    PROCEDURE notify_requester_expired(
        p_event_id        IN NUMBER,
        p_requester_email IN VARCHAR2,
        p_target          IN VARCHAR2,
        p_event_type      IN VARCHAR2
    ) IS
        l_subject VARCHAR2(500);
        l_body    CLOB;
    BEGIN
        l_subject := 'Break Glass Request Expired - Event #' || p_event_id;

        l_body := 'Your break-glass access request has expired without approval.' || CHR(10) || CHR(10)
            || 'Event ID: ' || p_event_id || CHR(10)
            || 'Type: ' || p_event_type || CHR(10)
            || 'Target: ' || p_target || CHR(10) || CHR(10)
            || 'The approver did not action your request before the deadline. '
            || 'Please submit a new request if you still require elevated access.';

        APEX_MAIL.SEND(
            p_to   => p_requester_email,
            p_from => c_from_address,
            p_subj => l_subject,
            p_body => l_body
        );

        APEX_MAIL.PUSH_QUEUE;
    END notify_requester_expired;

    ----------------------------------------------------------------------------
    -- notify_revocation_failed
    ----------------------------------------------------------------------------
    PROCEDURE notify_revocation_failed(
        p_event_id        IN NUMBER,
        p_requester_email IN VARCHAR2,
        p_approver_email  IN VARCHAR2,
        p_target          IN VARCHAR2
    ) IS
        l_subject VARCHAR2(500);
        l_body    CLOB;
    BEGIN
        l_subject := 'URGENT: Revocation Failed - Event #' || p_event_id;

        l_body := 'IMPORTANT: Automatic revocation of elevated access has failed '
            || 'after exhausting all retry attempts.' || CHR(10) || CHR(10)
            || 'Event ID: ' || p_event_id || CHR(10)
            || 'Target: ' || p_target || CHR(10) || CHR(10)
            || 'Manual intervention is required to remove the user from the '
            || 'elevated group. Please contact an administrator immediately.';

        -- Notify the requester
        APEX_MAIL.SEND(
            p_to   => p_requester_email,
            p_from => c_from_address,
            p_subj => l_subject,
            p_body => l_body
        );

        -- Notify the approver
        APEX_MAIL.SEND(
            p_to   => p_approver_email,
            p_from => c_from_address,
            p_subj => l_subject,
            p_body => l_body
        );

        APEX_MAIL.PUSH_QUEUE;
    END notify_revocation_failed;

END pkg_notifications;
/
