-- BREAK_GLASS_EVENT table
-- Stores break-glass access request events including time windows, approval state, and workflow tracking.
-- Requirement 4.1, 9.1: Record break-glass requests for group membership and password reveal scenarios.

CREATE TABLE break_glass_event (
    event_id             NUMBER GENERATED ALWAYS AS IDENTITY
                         CONSTRAINT break_glass_event_pk PRIMARY KEY,
    event_type           VARCHAR2(20)   NOT NULL
                         CONSTRAINT bge_event_type_chk
                         CHECK (event_type IN ('GROUP','PASSWORD')),
    target_identifier    VARCHAR2(200)  NOT NULL,
    requesting_user      VARCHAR2(200)  NOT NULL,
    approver_username    VARCHAR2(200),
    status               VARCHAR2(30)   DEFAULT 'started' NOT NULL
                         CONSTRAINT bge_status_chk
                         CHECK (status IN (
                             'started','approval_pending','approved','denied',
                             'expired','active','revoked','revocation_failed',
                             'password_revealed','password_reset',
                             'audit_captured','audit_capture_failed','error'
                         )),
    start_time           TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time             TIMESTAMP WITH TIME ZONE NOT NULL,
    ticket_reference     VARCHAR2(100)  NOT NULL
                         CONSTRAINT bge_ticket_ref_chk
                         CHECK (TRIM(ticket_reference) IS NOT NULL AND LENGTH(TRIM(ticket_reference)) >= 1),
    description          VARCHAR2(500)  NOT NULL
                         CONSTRAINT bge_description_chk
                         CHECK (LENGTH(description) BETWEEN 1 AND 500),
    tenancy_id           NUMBER         NOT NULL
                         CONSTRAINT bge_tenancy_fk
                         REFERENCES idcs_tenancy(tenancy_id),
    workflow_instance_id NUMBER,
    approval_comment     VARCHAR2(1000),
    created_at           TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
    updated_at           TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
    CONSTRAINT bge_time_window_chk CHECK (start_time < end_time)
);

COMMENT ON TABLE break_glass_event IS 'Break-glass access request events with time windows, approval tracking, and workflow state';
COMMENT ON COLUMN break_glass_event.event_id IS 'Surrogate primary key (identity column)';
COMMENT ON COLUMN break_glass_event.event_type IS 'Type of break-glass request: GROUP (group membership) or PASSWORD (password reveal)';
COMMENT ON COLUMN break_glass_event.target_identifier IS 'Target group name or user name for the elevated access request';
COMMENT ON COLUMN break_glass_event.requesting_user IS 'Username of the user requesting break-glass access';
COMMENT ON COLUMN break_glass_event.approver_username IS 'Username of selected approver (null if auto-approved)';
COMMENT ON COLUMN break_glass_event.status IS 'Current workflow status of the event';
COMMENT ON COLUMN break_glass_event.start_time IS 'Requested start of elevated access window';
COMMENT ON COLUMN break_glass_event.end_time IS 'Requested end of elevated access window';
COMMENT ON COLUMN break_glass_event.ticket_reference IS 'External ticket or incident reference for audit trail';
COMMENT ON COLUMN break_glass_event.description IS 'User-provided justification for the break-glass request';
COMMENT ON COLUMN break_glass_event.tenancy_id IS 'Foreign key to the associated IDCS tenancy';
COMMENT ON COLUMN break_glass_event.workflow_instance_id IS 'APEX Workflow instance identifier';
COMMENT ON COLUMN break_glass_event.approval_comment IS 'Approver comment on approval or denial';
COMMENT ON COLUMN break_glass_event.created_at IS 'Record creation timestamp';
COMMENT ON COLUMN break_glass_event.updated_at IS 'Last modification timestamp';
