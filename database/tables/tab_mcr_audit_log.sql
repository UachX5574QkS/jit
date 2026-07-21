-- TAB_MCR_AUDIT_LOG table
-- Append-only audit trail for all MCR Manager data modifications.
-- This table should NOT have UPDATE or DELETE grants. It is insert-only by design.
-- Requirements 13.1, 13.4, 15.1: Record all create, update, and delete operations with user, timestamp, and change details.

CREATE TABLE tab_mcr_audit_log (
    audit_id             NUMBER GENERATED ALWAYS AS IDENTITY
                         CONSTRAINT con_mcr_audit_pk PRIMARY KEY,
    user_id              NUMBER         NOT NULL,
    event_time           TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
    operation            VARCHAR2(10)   NOT NULL
                         CONSTRAINT con_mcr_audit_op_chk
                         CHECK (operation IN ('CREATE', 'UPDATE', 'DELETE')),
    object_type          VARCHAR2(30)   NOT NULL,
    object_id            NUMBER         NOT NULL,
    old_values           CLOB,
    new_values           CLOB
);

COMMENT ON TABLE tab_mcr_audit_log IS 'Append-only audit trail recording all create, update, and delete operations on MCR Manager objects. No UPDATE or DELETE grants should be issued on this table.';
COMMENT ON COLUMN tab_mcr_audit_log.audit_id IS 'Surrogate primary key (identity column)';
COMMENT ON COLUMN tab_mcr_audit_log.user_id IS 'Numeric ID of the acting user who performed the operation';
COMMENT ON COLUMN tab_mcr_audit_log.event_time IS 'Timestamp when the operation occurred (defaults to SYSTIMESTAMP)';
COMMENT ON COLUMN tab_mcr_audit_log.operation IS 'Type of operation: CREATE, UPDATE, or DELETE';
COMMENT ON COLUMN tab_mcr_audit_log.object_type IS 'Type of object modified (e.g., MCR, TASK, ACTION, DOCUMENT, DOC_LINK, RACI)';
COMMENT ON COLUMN tab_mcr_audit_log.object_id IS 'Identifier of the target object that was modified';
COMMENT ON COLUMN tab_mcr_audit_log.old_values IS 'JSON representation of previous field values (NULL for CREATE operations)';
COMMENT ON COLUMN tab_mcr_audit_log.new_values IS 'JSON representation of new field values (NULL for DELETE operations)';
