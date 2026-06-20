CREATE OR REPLACE PACKAGE pkg_notifications AS
    /*
    ** PKG_NOTIFICATIONS - Email Notification Delivery
    **
    ** Sends lifecycle email notifications for break-glass events using
    ** APEX_MAIL.SEND. Covers approval requests, approval/denial/expiry
    ** confirmations, and revocation failure alerts.
    **
    ** Requirements: 6.1, 6.3, 6.4, 7.4, 7.5, 7.6, 10.1, 10.5, 10.6
    */

    ----------------------------------------------------------------------------
    -- Constants
    ----------------------------------------------------------------------------
    c_from_address CONSTANT VARCHAR2(100) := 'jit-noreply@example.com';

    ----------------------------------------------------------------------------
    -- notify_approver
    --
    -- Sends an approval request email to the designated approver. The email
    -- contains the requesting user, target, event type, time window, ticket
    -- reference, and an action URL for approve/deny.
    --
    -- Parameters:
    --   p_event_id         - The break-glass event identifier
    --   p_approver_email   - Email address of the approver
    --   p_requesting_user  - Username of the person requesting access
    --   p_target           - Target group name or user account
    --   p_event_type       - 'GROUP' or 'PASSWORD'
    --   p_start_time       - Start of the requested time window
    --   p_end_time         - End of the requested time window
    --   p_ticket_reference - External ticket/incident reference
    --   p_action_url       - URL for the approver to approve or deny
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
    );

    ----------------------------------------------------------------------------
    -- notify_requester_approved
    --
    -- Sends a notification to the requester that their break-glass request
    -- has been approved.
    --
    -- Parameters:
    --   p_event_id        - The break-glass event identifier
    --   p_requester_email - Email address of the requesting user
    --   p_target          - Target group name or user account
    --   p_event_type      - 'GROUP' or 'PASSWORD'
    ----------------------------------------------------------------------------
    PROCEDURE notify_requester_approved(
        p_event_id        IN NUMBER,
        p_requester_email IN VARCHAR2,
        p_target          IN VARCHAR2,
        p_event_type      IN VARCHAR2
    );

    ----------------------------------------------------------------------------
    -- notify_requester_denied
    --
    -- Sends a notification to the requester that their break-glass request
    -- has been denied, optionally including the approver's comment.
    --
    -- Parameters:
    --   p_event_id        - The break-glass event identifier
    --   p_requester_email - Email address of the requesting user
    --   p_target          - Target group name or user account
    --   p_event_type      - 'GROUP' or 'PASSWORD'
    --   p_comment         - Optional approver comment explaining the denial
    ----------------------------------------------------------------------------
    PROCEDURE notify_requester_denied(
        p_event_id        IN NUMBER,
        p_requester_email IN VARCHAR2,
        p_target          IN VARCHAR2,
        p_event_type      IN VARCHAR2,
        p_comment         IN VARCHAR2 DEFAULT NULL
    );

    ----------------------------------------------------------------------------
    -- notify_requester_expired
    --
    -- Sends a notification to the requester that their break-glass request
    -- has expired without receiving approval.
    --
    -- Parameters:
    --   p_event_id        - The break-glass event identifier
    --   p_requester_email - Email address of the requesting user
    --   p_target          - Target group name or user account
    --   p_event_type      - 'GROUP' or 'PASSWORD'
    ----------------------------------------------------------------------------
    PROCEDURE notify_requester_expired(
        p_event_id        IN NUMBER,
        p_requester_email IN VARCHAR2,
        p_target          IN VARCHAR2,
        p_event_type      IN VARCHAR2
    );

    ----------------------------------------------------------------------------
    -- notify_revocation_failed
    --
    -- Sends a notification to both the requester and approver that the
    -- revocation of elevated access has failed after exhausting retries.
    --
    -- Parameters:
    --   p_event_id        - The break-glass event identifier
    --   p_requester_email - Email address of the requesting user
    --   p_approver_email  - Email address of the approver
    --   p_target          - Target group name or user account
    ----------------------------------------------------------------------------
    PROCEDURE notify_revocation_failed(
        p_event_id        IN NUMBER,
        p_requester_email IN VARCHAR2,
        p_approver_email  IN VARCHAR2,
        p_target          IN VARCHAR2
    );

END pkg_notifications;
/
