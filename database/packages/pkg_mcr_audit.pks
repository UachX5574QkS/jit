CREATE OR REPLACE PACKAGE pkg_mcr_audit AS
    /*
    ** PKG_MCR_AUDIT
    ** Audit trail operations for MCR Manager. Records all create, update, and
    ** delete operations on MCR objects into tab_mcr_audit_log.
    **
    ** Requirements 13.1, 13.2, 13.3: Record operations with user, timestamp,
    ** changed fields (old/new JSON), within the caller's transaction.
    */

    ----------------------------------------------------------------------------
    -- log_change
    --
    -- Records an audit entry for a data modification. The INSERT is performed
    -- within the caller's transaction (no autonomous transaction) so that the
    -- audit row is committed or rolled back together with the data change.
    --
    -- Parameters:
    --   p_user_id      - Numeric ID of the acting user
    --   p_operation    - Operation type: 'CREATE', 'UPDATE', or 'DELETE'
    --   p_object_type  - Type of object modified (e.g., 'MCR', 'TASK', 'ACTION',
    --                    'DOCUMENT', 'DOC_LINK', 'RACI')
    --   p_object_id    - Identifier of the target object
    --   p_old_values   - JSON representation of previous field values
    --                    (NULL for CREATE operations)
    --   p_new_values   - JSON representation of new field values
    --                    (NULL for DELETE operations)
    ----------------------------------------------------------------------------
    PROCEDURE log_change(
        p_user_id      IN NUMBER,
        p_operation    IN VARCHAR2,
        p_object_type  IN VARCHAR2,
        p_object_id    IN NUMBER,
        p_old_values   IN CLOB DEFAULT NULL,
        p_new_values   IN CLOB DEFAULT NULL
    );

    ----------------------------------------------------------------------------
    -- get_audit_trail
    --
    -- Returns the audit history for a given object type and object identifier,
    -- ordered by event_time descending (newest first).
    --
    -- Parameters:
    --   p_object_type - Type of object to retrieve history for
    --   p_object_id   - Identifier of the target object
    --
    -- Returns:
    --   SYS_REFCURSOR with audit log records
    ----------------------------------------------------------------------------
    FUNCTION get_audit_trail(
        p_object_type IN VARCHAR2,
        p_object_id   IN NUMBER
    ) RETURN SYS_REFCURSOR;

END pkg_mcr_audit;
/
