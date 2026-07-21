CREATE OR REPLACE PACKAGE pkg_mcr_lifecycle AS
    /*
    ** PKG_MCR_LIFECYCLE
    ** Handles MCR status transitions, approval logic, lock enforcement, and
    ** scheduled lifecycle automation. Provides procedures for approving,
    ** locking, handling post-approval modifications, and querying partial
    ** changes since the last approval.
    **
    ** Requirements 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 10.1, 10.2, 10.3, 10.4, 13.1:
    ** Approval prerequisites, status transitions, lock enforcement, scheduled
    ** automation, and audit trail recording.
    */

    ----------------------------------------------------------------------------
    -- Custom Exceptions
    ----------------------------------------------------------------------------
    e_not_pending          EXCEPTION;
    e_not_approved         EXCEPTION;
    e_prerequisites_failed EXCEPTION;
    e_insufficient_perm    EXCEPTION;

    PRAGMA EXCEPTION_INIT(e_not_pending,          -20030);
    PRAGMA EXCEPTION_INIT(e_not_approved,         -20031);
    PRAGMA EXCEPTION_INIT(e_prerequisites_failed, -20032);
    PRAGMA EXCEPTION_INIT(e_insufficient_perm,    -20033);

    ----------------------------------------------------------------------------
    -- approve_mcr
    --
    -- Validates that the MCR is in Pending status, that the acting user is in
    -- the Management Group (Responsible or Accountable in RACI), and that all
    -- approval prerequisites are met (all tasks have Jira references and at
    -- least one linked document). Transitions the MCR to Approved status,
    -- records the approving user and timestamp, and logs the change in the
    -- audit trail.
    --
    -- Parameters:
    --   p_user_id - Numeric ID of the acting user (must be Management Group)
    --   p_mcr_id  - ID of the MCR to approve
    --
    -- Raises:
    --   e_not_pending          - If the MCR status is not 'Pending'
    --   e_insufficient_perm    - If the user is not in the Management Group
    --   e_prerequisites_failed - If tasks are missing Jira refs or documents
    ----------------------------------------------------------------------------
    PROCEDURE approve_mcr(
        p_user_id IN NUMBER,
        p_mcr_id  IN NUMBER
    );

    ----------------------------------------------------------------------------
    -- lock_mcr
    --
    -- Validates that the MCR is in Approved status and transitions it to
    -- Locked, preventing all further data modifications. Records the lock
    -- in the audit trail.
    --
    -- Parameters:
    --   p_user_id - Numeric ID of the acting user
    --   p_mcr_id  - ID of the MCR to lock
    --
    -- Raises:
    --   e_not_approved - If the MCR status is not 'Approved'
    ----------------------------------------------------------------------------
    PROCEDURE lock_mcr(
        p_user_id IN NUMBER,
        p_mcr_id  IN NUMBER
    );

    ----------------------------------------------------------------------------
    -- handle_task_modification
    --
    -- Called when any task data is modified within an MCR. If the MCR is
    -- currently in Approved status, reverts it to Partial status, clears the
    -- approval fields (approved_by_user_id and approved_at), and records the
    -- change in the audit trail.
    --
    -- Parameters:
    --   p_mcr_id - ID of the MCR whose task was modified
    ----------------------------------------------------------------------------
    PROCEDURE handle_task_modification(
        p_mcr_id IN NUMBER
    );

    ----------------------------------------------------------------------------
    -- get_partial_changes
    --
    -- Returns a JSON array of tasks that have been modified since the MCR
    -- was last approved. Used when the MCR is in Partial status to show the
    -- user which tasks caused the approval to be reverted.
    --
    -- Parameters:
    --   p_mcr_id - ID of the MCR to query
    ----------------------------------------------------------------------------
    PROCEDURE get_partial_changes(
        p_mcr_id IN NUMBER
    );

    ----------------------------------------------------------------------------
    -- check_approval_prerequisites
    --
    -- Validates that ALL tasks within the specified MCR have a non-null
    -- jira_reference AND at least one entry in tab_mcr_doc_links. If any
    -- task fails either check, raises e_prerequisites_failed with a message
    -- identifying the non-compliant task IDs.
    --
    -- Parameters:
    --   p_mcr_id - ID of the MCR to validate
    --
    -- Raises:
    --   e_prerequisites_failed - If any task is missing Jira ref or documents
    ----------------------------------------------------------------------------
    PROCEDURE check_approval_prerequisites(
        p_mcr_id IN NUMBER
    );

    ----------------------------------------------------------------------------
    -- run_scheduled_transitions
    --
    -- Scheduled job entry point that evaluates all MCRs eligible for
    -- automatic status transitions:
    --   Locked → Active   (when current date is within start/end window)
    --   Active → Complete (when all tasks are Complete)
    --   Active → Partial_Complete (all tasks terminal, not all Complete)
    --   Active → DNF      (end date passed, tasks not all terminal)
    --
    -- STUB: Will be implemented in task 6.2.
    ----------------------------------------------------------------------------
    PROCEDURE run_scheduled_transitions;

END pkg_mcr_lifecycle;
/
