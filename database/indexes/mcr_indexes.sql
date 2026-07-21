-- Performance indexes for MCR Manager
-- Optimizes common query patterns: task lookups by MCR, status filtering,
-- dependency traversal, request status queries, and audit log searches.
-- Requirements: 15.1, 15.3

--------------------------------------------------------------------------------
-- TAB_MCR_TASKS indexes
--------------------------------------------------------------------------------

-- Supports task list queries filtered by parent MCR
CREATE INDEX ind_mcr_tasks_mcr_id ON tab_mcr_tasks(mcr_id);

-- Supports status-based filtering (active tasks, blocked tasks, progress calculations)
CREATE INDEX ind_mcr_tasks_status ON tab_mcr_tasks(task_status);

--------------------------------------------------------------------------------
-- TAB_MCR_DEPENDENCIES indexes
--------------------------------------------------------------------------------

-- Supports lookup of dependencies for a given task
CREATE INDEX ind_mcr_deps_task ON tab_mcr_dependencies(task_id);

-- Supports reverse lookup: which tasks depend on a given task
CREATE INDEX ind_mcr_deps_depends ON tab_mcr_dependencies(depends_on_task_id);

--------------------------------------------------------------------------------
-- TAB_MCR_REQUESTS indexes
--------------------------------------------------------------------------------

-- Supports active/archived MCR list queries filtered by status
CREATE INDEX ind_mcr_requests_status ON tab_mcr_requests(mcr_status);

--------------------------------------------------------------------------------
-- TAB_MCR_AUDIT_LOG indexes
--------------------------------------------------------------------------------

-- Supports audit trail queries by object type and object ID
CREATE INDEX ind_mcr_audit_object ON tab_mcr_audit_log(object_type, object_id);
