-- Indexes for JIT Break Glass schema
-- Optimizes query performance for common access patterns: user lookups, status filtering,
-- approval workflows, and foreign key traversal.
-- Requirements: 12.1, 14.4

--------------------------------------------------------------------------------
-- BREAK_GLASS_EVENT indexes
--------------------------------------------------------------------------------

-- Supports "My Requests" queries filtering by requesting user
CREATE INDEX idx_bge_requesting_user ON break_glass_event(requesting_user);

-- Supports "My Approvals" queries filtering by approver
CREATE INDEX idx_bge_approver ON break_glass_event(approver_username);

-- Supports status-based filtering and workflow state queries
CREATE INDEX idx_bge_status ON break_glass_event(status);

-- Supports combined event_type + status queries (e.g. active group events, pending password events)
CREATE INDEX idx_bge_type_status ON break_glass_event(event_type, status);

--------------------------------------------------------------------------------
-- EVENT_STATUS_HISTORY indexes
--------------------------------------------------------------------------------

-- Supports foreign key lookups and event timeline queries
CREATE INDEX idx_esh_event_id ON event_status_history(event_id);

--------------------------------------------------------------------------------
-- PASSWORD_REVEAL_LOG indexes
--------------------------------------------------------------------------------

-- Supports foreign key lookups and event-specific reveal history queries
CREATE INDEX idx_prl_event_id ON password_reveal_log(event_id);

-- Supports queries for pending password resets (workflow scheduling)
-- Note: Only rows with reset_status = 'pending' are of interest to the reset scheduler.
-- Using a function-based index to approximate a partial index in Oracle.
CREATE INDEX idx_prl_reset_status ON password_reveal_log(
    CASE WHEN reset_status = 'pending' THEN reset_status END
);

--------------------------------------------------------------------------------
-- EVENT_AUDIT_LOG indexes
--------------------------------------------------------------------------------

-- Enforces one audit log per event and supports fast lookup by event_id
CREATE UNIQUE INDEX idx_eal_event_id ON event_audit_log(event_id);

--------------------------------------------------------------------------------
-- APPROVAL_TOKEN indexes
--------------------------------------------------------------------------------

-- Enforces token uniqueness and supports fast token lookup (timing-attack resistant)
CREATE UNIQUE INDEX idx_at_token_hash ON approval_token(token_hash);

-- Supports foreign key lookups and queries for tokens by event
CREATE INDEX idx_at_event_id ON approval_token(event_id);
