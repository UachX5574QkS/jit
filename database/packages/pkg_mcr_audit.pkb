CREATE OR REPLACE PACKAGE BODY pkg_mcr_audit AS
    /*
    ** PKG_MCR_AUDIT (Body)
    ** Audit trail operations for MCR Manager. Records all create, update, and
    ** delete operations on MCR objects into tab_mcr_audit_log.
    */

    ----------------------------------------------------------------------------
    -- log_change
    ----------------------------------------------------------------------------
    PROCEDURE log_change(
        p_user_id      IN NUMBER,
        p_operation    IN VARCHAR2,
        p_object_type  IN VARCHAR2,
        p_object_id    IN NUMBER,
        p_old_values   IN CLOB DEFAULT NULL,
        p_new_values   IN CLOB DEFAULT NULL
    ) IS
    BEGIN
        INSERT INTO tab_mcr_audit_log (
            user_id,
            event_time,
            operation,
            object_type,
            object_id,
            old_values,
            new_values
        ) VALUES (
            p_user_id,
            SYSTIMESTAMP,
            p_operation,
            p_object_type,
            p_object_id,
            p_old_values,
            p_new_values
        );
    END log_change;

    ----------------------------------------------------------------------------
    -- get_audit_trail
    ----------------------------------------------------------------------------
    FUNCTION get_audit_trail(
        p_object_type IN VARCHAR2,
        p_object_id   IN NUMBER
    ) RETURN SYS_REFCURSOR IS
        l_cursor SYS_REFCURSOR;
    BEGIN
        OPEN l_cursor FOR
            SELECT audit_id,
                   user_id,
                   event_time,
                   operation,
                   object_type,
                   object_id,
                   old_values,
                   new_values
              FROM tab_mcr_audit_log
             WHERE object_type = p_object_type
               AND object_id  = p_object_id
             ORDER BY event_time DESC;

        RETURN l_cursor;
    END get_audit_trail;

END pkg_mcr_audit;
/
