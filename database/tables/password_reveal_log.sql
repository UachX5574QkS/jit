-- PASSWORD_REVEAL_LOG table
-- Tracks each password reveal action and its subsequent automated reset lifecycle.
-- Requirement 11.4: Initiate password reset workflow 15 minutes after reveal.
-- Requirement 11.7: Retry reset up to 3 times on failure and log for admin review.

CREATE TABLE password_reveal_log (
    reveal_id          NUMBER GENERATED ALWAYS AS IDENTITY
                       CONSTRAINT password_reveal_log_pk PRIMARY KEY,
    event_id           NUMBER NOT NULL
                       CONSTRAINT prl_break_glass_event_fk
                       REFERENCES break_glass_event (event_id),
    requesting_user    VARCHAR2(200) NOT NULL,
    revealed_at        TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
    reset_scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
    reset_completed_at TIMESTAMP WITH TIME ZONE,
    reset_status       VARCHAR2(20) DEFAULT 'pending' NOT NULL
                       CONSTRAINT prl_reset_status_chk
                       CHECK (reset_status IN ('pending', 'completed', 'failed')),
    retry_count        NUMBER DEFAULT 0 NOT NULL
);

COMMENT ON TABLE password_reveal_log IS 'Records each password reveal action and tracks the automated password reset lifecycle';
COMMENT ON COLUMN password_reveal_log.reveal_id IS 'Surrogate primary key (identity column)';
COMMENT ON COLUMN password_reveal_log.event_id IS 'Foreign key to the parent break-glass event';
COMMENT ON COLUMN password_reveal_log.requesting_user IS 'Username of the user who triggered the password reveal';
COMMENT ON COLUMN password_reveal_log.revealed_at IS 'Timestamp when the password was revealed to the user';
COMMENT ON COLUMN password_reveal_log.reset_scheduled_at IS 'Timestamp when the automated password reset is scheduled (revealed_at + 15 minutes)';
COMMENT ON COLUMN password_reveal_log.reset_completed_at IS 'Timestamp when the password reset completed successfully (NULL if pending or failed)';
COMMENT ON COLUMN password_reveal_log.reset_status IS 'Current reset lifecycle status: pending, completed, or failed';
COMMENT ON COLUMN password_reveal_log.retry_count IS 'Number of reset retry attempts (max 3 per requirement 11.7)';
