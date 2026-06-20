-- EVENT_STATUS_HISTORY table
-- Records every status transition for a break-glass event, providing a full audit trail.
-- Requirement 13.5: Record a UTC timestamp for each workflow stage transition.

CREATE TABLE event_status_history (
    history_id    NUMBER GENERATED ALWAYS AS IDENTITY
                  CONSTRAINT event_status_history_pk PRIMARY KEY,
    event_id      NUMBER NOT NULL
                  CONSTRAINT esh_break_glass_event_fk
                  REFERENCES break_glass_event (event_id),
    from_status   VARCHAR2(30),
    to_status     VARCHAR2(30)  NOT NULL,
    changed_by    VARCHAR2(200) NOT NULL,
    change_reason VARCHAR2(500),
    changed_at    TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

COMMENT ON TABLE event_status_history IS 'Audit trail of all status transitions for break-glass events';
COMMENT ON COLUMN event_status_history.history_id IS 'Surrogate primary key (identity column)';
COMMENT ON COLUMN event_status_history.event_id IS 'FK to the break-glass event whose status changed';
COMMENT ON COLUMN event_status_history.from_status IS 'Previous status value (NULL for the initial record)';
COMMENT ON COLUMN event_status_history.to_status IS 'New status value after the transition';
COMMENT ON COLUMN event_status_history.changed_by IS 'Username or system identifier that triggered the transition';
COMMENT ON COLUMN event_status_history.change_reason IS 'Optional reason or comment for the status change';
COMMENT ON COLUMN event_status_history.changed_at IS 'UTC timestamp when the transition occurred';
