CREATE OR REPLACE PACKAGE pkg_break_glass AS
    /*
    ** PKG_BREAK_GLASS
    ** Business logic for break-glass access requests: request validation,
    ** event creation, status transitions, and authorization checks.
    */

    ----------------------------------------------------------------------------
    -- Custom exception numbers
    ----------------------------------------------------------------------------
    e_validation_failed    EXCEPTION;
    e_authorization_failed EXCEPTION;
    e_invalid_status       EXCEPTION;

    PRAGMA EXCEPTION_INIT(e_validation_failed,    -20001);
    PRAGMA EXCEPTION_INIT(e_authorization_failed, -20002);
    PRAGMA EXCEPTION_INIT(e_invalid_status,       -20003);

    ----------------------------------------------------------------------------
    -- validate_request
    --
    -- Validates a break-glass request's input fields. Raises e_validation_failed
    -- (ORA-20001) if any validation rule is violated:
    --   - p_start_time must not be in the past (compared to SYSTIMESTAMP)
    --   - p_start_time must be before p_end_time
    --   - For GROUP event type: duration must not exceed 72 hours
    --   - p_ticket_reference trimmed length must be between 1 and 100 characters
    --   - p_description length must be between 1 and 500 characters
    --
    -- Parameters:
    --   p_event_type       - Event type: 'GROUP' or 'PASSWORD'
    --   p_start_time       - Requested start of elevated access window
    --   p_end_time         - Requested end of elevated access window
    --   p_ticket_reference - External ticket/incident reference
    --   p_description      - User-provided justification
    ----------------------------------------------------------------------------
    PROCEDURE validate_request(
        p_event_type       IN VARCHAR2,
        p_start_time       IN TIMESTAMP WITH TIME ZONE,
        p_end_time         IN TIMESTAMP WITH TIME ZONE,
        p_ticket_reference IN VARCHAR2,
        p_description      IN VARCHAR2
    );

    ----------------------------------------------------------------------------
    -- create_event
    --
    -- Creates a new break-glass event record with status 'started' and inserts
    -- the initial status history entry (from_status NULL, to_status 'started').
    -- Returns the generated event_id.
    --
    -- Parameters:
    --   p_event_type        - 'GROUP' or 'PASSWORD'
    --   p_target_identifier - Target group name or user name
    --   p_requesting_user   - Username of the requesting user
    --   p_approver_username - Username of the selected approver (NULL if auto-approved)
    --   p_start_time        - Requested start of elevated access window
    --   p_end_time          - Requested end of elevated access window
    --   p_ticket_reference  - External ticket/incident reference
    --   p_description       - User-provided justification
    --   p_tenancy_id        - FK to the associated IDCS tenancy
    --
    -- Returns:
    --   The generated event_id (NUMBER)
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
    ) RETURN NUMBER;

    ----------------------------------------------------------------------------
    -- update_event_status
    --
    -- Updates the status of an existing break-glass event and inserts a
    -- corresponding record into event_status_history. Also updates the
    -- event's updated_at timestamp.
    --
    -- Parameters:
    --   p_event_id      - The event to update
    --   p_new_status    - The new status value
    --   p_changed_by    - Username or system identifier triggering the change
    --   p_change_reason - Optional reason/comment for the status change
    ----------------------------------------------------------------------------
    PROCEDURE update_event_status(
        p_event_id      IN NUMBER,
        p_new_status    IN VARCHAR2,
        p_changed_by    IN VARCHAR2,
        p_change_reason IN VARCHAR2 DEFAULT NULL
    );

    ----------------------------------------------------------------------------
    -- get_user_events
    --
    -- Returns all break-glass events where the specified user is either the
    -- requesting_user (owner) or the approver_username. Results are ordered
    -- by created_at DESC (newest first).
    --
    -- Parameters:
    --   p_username - The username to filter events for
    --
    -- Returns:
    --   SYS_REFCURSOR with event records
    ----------------------------------------------------------------------------
    FUNCTION get_user_events(
        p_username IN VARCHAR2
    ) RETURN SYS_REFCURSOR;

    ----------------------------------------------------------------------------
    -- get_event_detail
    --
    -- Returns the full detail of a single break-glass event by its event_id.
    --
    -- Parameters:
    --   p_event_id - The event identifier
    --
    -- Returns:
    --   SYS_REFCURSOR with the single event record
    ----------------------------------------------------------------------------
    FUNCTION get_event_detail(
        p_event_id IN NUMBER
    ) RETURN SYS_REFCURSOR;

    ----------------------------------------------------------------------------
    -- authorize_user_for_event
    --
    -- Checks whether the specified user is authorized to access the given event.
    -- A user is authorized if they are the requesting_user (owner) or the
    -- approver_username for that event. Raises e_authorization_failed (ORA-20002)
    -- if the user is neither.
    --
    -- Parameters:
    --   p_event_id  - The event to check authorization for
    --   p_username  - The username to authorize
    ----------------------------------------------------------------------------
    PROCEDURE authorize_user_for_event(
        p_event_id IN NUMBER,
        p_username IN VARCHAR2
    );

END pkg_break_glass;
/
