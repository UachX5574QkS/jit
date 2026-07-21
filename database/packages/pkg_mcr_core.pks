CREATE OR REPLACE PACKAGE pkg_mcr_core AS
    /*
    ** PKG_MCR_CORE
    ** Handles MCR record CRUD and RACI assignment management. Provides
    ** procedures for creating, updating, retrieving, and cancelling MCRs,
    ** as well as a function to check Management Group membership.
    **
    ** Requirements 3.3, 3.4, 3.5, 3.7: MCR creation with validation,
    ** RACI assignments, date range checks, and lifecycle operations.
    */

    ----------------------------------------------------------------------------
    -- Custom Exceptions
    ----------------------------------------------------------------------------
    e_missing_fields     EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_missing_fields, -20001);

    e_invalid_dates      EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_invalid_dates, -20002);

    e_mcr_locked         EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_mcr_locked, -20003);

    e_mcr_archived       EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_mcr_archived, -20004);

    e_insufficient_perm  EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_insufficient_perm, -20005);

    ----------------------------------------------------------------------------
    -- create_mcr
    --
    -- Creates a new MCR record with Draft status and inserts RACI assignments
    -- from the provided JSON. Validates that all required fields are present
    -- and that the date range is valid (end_date >= start_date).
    --
    -- Parameters:
    --   p_user_id        - Numeric ID of the acting user (creator)
    --   p_mcr_number     - User-assigned unique MCR identifier
    --   p_owner_user_id  - Numeric ID of the MCR owner
    --   p_description    - Description of the managed change request
    --   p_start_date     - Estimated start date
    --   p_end_date       - Estimated end date
    --   p_raci_json      - JSON array of RACI assignments, e.g.
    --                      [{"user_id":1,"role":"Responsible"},...]
    --
    -- Raises:
    --   e_missing_fields  - If any required field is NULL or RACI is incomplete
    --   e_invalid_dates   - If p_end_date < p_start_date
    ----------------------------------------------------------------------------
    PROCEDURE create_mcr(
        p_user_id        IN NUMBER,
        p_mcr_number     IN VARCHAR2,
        p_owner_user_id  IN NUMBER,
        p_description    IN VARCHAR2,
        p_start_date     IN DATE,
        p_end_date       IN DATE,
        p_raci_json      IN CLOB
    );

    ----------------------------------------------------------------------------
    -- update_mcr
    --
    -- Updates an existing MCR's description, dates, and RACI assignments.
    -- Only permitted when the MCR is in an editable state (Draft, Review,
    -- Pending, Partial, Approved). Validates date range.
    --
    -- Parameters:
    --   p_user_id    - Numeric ID of the acting user
    --   p_mcr_id     - ID of the MCR to update
    --   p_description - New description
    --   p_start_date - New estimated start date
    --   p_end_date   - New estimated end date
    --   p_raci_json  - Updated JSON array of RACI assignments
    --
    -- Raises:
    --   e_mcr_locked      - If MCR is in Locked state
    --   e_mcr_archived    - If MCR is in a terminal state
    --   e_invalid_dates   - If p_end_date < p_start_date
    ----------------------------------------------------------------------------
    PROCEDURE update_mcr(
        p_user_id    IN NUMBER,
        p_mcr_id     IN NUMBER,
        p_description IN VARCHAR2,
        p_start_date IN DATE,
        p_end_date   IN DATE,
        p_raci_json  IN CLOB
    );

    ----------------------------------------------------------------------------
    -- get_mcr
    --
    -- Returns MCR details including RACI assignments as JSON output
    -- via APEX_JSON or SYS_REFCURSOR.
    --
    -- Parameters:
    --   p_mcr_id - ID of the MCR to retrieve
    ----------------------------------------------------------------------------
    PROCEDURE get_mcr(
        p_mcr_id IN NUMBER
    );

    ----------------------------------------------------------------------------
    -- get_active_mcrs
    --
    -- Returns all MCRs that are NOT in terminal states (Complete,
    -- Partial_Complete, Cancelled, DNF). Includes progress calculation
    -- for each MCR.
    ----------------------------------------------------------------------------
    PROCEDURE get_active_mcrs;

    ----------------------------------------------------------------------------
    -- get_archived_mcrs
    --
    -- Returns all MCRs in terminal states (Complete, Partial_Complete,
    -- Cancelled, DNF) for the Archived view.
    ----------------------------------------------------------------------------
    PROCEDURE get_archived_mcrs;

    ----------------------------------------------------------------------------
    -- cancel_mcr
    --
    -- Transitions an MCR to Cancelled status. Only permitted from states:
    -- Draft, Review, Active. Records the transition in the audit log.
    --
    -- Parameters:
    --   p_user_id - Numeric ID of the acting user
    --   p_mcr_id  - ID of the MCR to cancel
    --
    -- Raises:
    --   e_mcr_locked   - If MCR is Locked (cannot cancel a locked MCR)
    --   e_mcr_archived - If MCR is already in a terminal state
    ----------------------------------------------------------------------------
    PROCEDURE cancel_mcr(
        p_user_id IN NUMBER,
        p_mcr_id  IN NUMBER
    );

    ----------------------------------------------------------------------------
    -- is_management_group
    --
    -- Checks whether the specified user is in the Management Group for a
    -- given MCR. A user is in the Management Group if they are assigned the
    -- Responsible or Accountable role in the MCR's RACI.
    --
    -- Parameters:
    --   p_user_id - Numeric ID of the user to check
    --   p_mcr_id  - ID of the MCR to check against
    --
    -- Returns:
    --   TRUE if the user is Responsible or Accountable, FALSE otherwise
    ----------------------------------------------------------------------------
    FUNCTION is_management_group(
        p_user_id IN NUMBER,
        p_mcr_id  IN NUMBER
    ) RETURN BOOLEAN;

END pkg_mcr_core;
/
