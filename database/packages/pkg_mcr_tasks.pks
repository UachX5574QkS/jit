CREATE OR REPLACE PACKAGE pkg_mcr_tasks AS
    /*
    ** PKG_MCR_TASKS
    ** Task CRUD, dependency validation, task status management, and action
    ** management for MCR Manager. Handles creation of tasks with sequential
    ** IDs, dependency graph validation (self-reference and circular detection),
    ** task status transitions with permission checks, and ordered action steps.
    **
    ** Requirements 4.3, 4.4, 4.5, 5.3: Task operations with dependency
    ** validation, sequential ordering, and action management.
    */

    ----------------------------------------------------------------------------
    -- Custom Exceptions
    ----------------------------------------------------------------------------
    e_self_dependency     EXCEPTION;
    e_circular_dependency EXCEPTION;
    e_task_not_found      EXCEPTION;
    e_insufficient_perm   EXCEPTION;

    PRAGMA EXCEPTION_INIT(e_self_dependency,     -20010);
    PRAGMA EXCEPTION_INIT(e_circular_dependency, -20011);
    PRAGMA EXCEPTION_INIT(e_task_not_found,      -20012);
    PRAGMA EXCEPTION_INIT(e_insufficient_perm,   -20013);

    ----------------------------------------------------------------------------
    -- create_task
    --
    -- Creates a new task within an MCR. Assigns a sequential task_seq value,
    -- validates hard and soft dependencies (no self-reference or circular
    -- chains), inserts dependencies into TAB_MCR_DEPENDENCIES, and records
    -- the creation in the audit log.
    --
    -- Parameters:
    --   p_user_id        - Numeric ID of the acting user
    --   p_mcr_id         - MCR to which the task belongs
    --   p_title          - Short descriptive title for the task
    --   p_description    - Detailed description of the task work
    --   p_jira_ref       - External Jira ticket reference
    --   p_start_time     - Planned execution start time
    --   p_duration       - Estimated duration in minutes
    --   p_owner_dept_id  - Department ID of the owning team
    --   p_implementor_id - ID of the implementor (user or department)
    --   p_impl_type      - Type of implementor: 'USER' or 'DEPARTMENT'
    --   p_benefits       - Description of benefits this task delivers
    --   p_hard_deps      - Comma-separated list of task_ids for hard dependencies
    --   p_soft_deps      - Comma-separated list of task_ids for soft dependencies
    --
    -- Raises:
    --   e_self_dependency     - If dependencies reference the task itself
    --   e_circular_dependency - If dependencies would create a cycle
    ----------------------------------------------------------------------------
    PROCEDURE create_task(
        p_user_id        IN NUMBER,
        p_mcr_id         IN NUMBER,
        p_title          IN VARCHAR2,
        p_description    IN VARCHAR2,
        p_jira_ref       IN VARCHAR2,
        p_start_time     IN TIMESTAMP WITH TIME ZONE,
        p_duration       IN NUMBER,
        p_owner_dept_id  IN NUMBER,
        p_implementor_id IN NUMBER,
        p_impl_type      IN VARCHAR2,
        p_benefits       IN VARCHAR2,
        p_hard_deps      IN VARCHAR2,
        p_soft_deps      IN VARCHAR2
    );

    ----------------------------------------------------------------------------
    -- update_task
    --
    -- Updates an existing task. Validates editable state, re-validates
    -- dependencies, updates the record, triggers handle_task_modification if
    -- the parent MCR is Approved, and records the change in the audit log
    -- with both old and new values.
    --
    -- Parameters:
    --   p_user_id        - Numeric ID of the acting user
    --   p_task_id        - ID of the task to update
    --   p_title          - New title value
    --   p_description    - New description value
    --   p_jira_ref       - New Jira reference value
    --   p_start_time     - New planned start time
    --   p_duration       - New estimated duration in minutes
    --   p_owner_dept_id  - New owning department ID
    --   p_implementor_id - New implementor ID
    --   p_impl_type      - New implementor type: 'USER' or 'DEPARTMENT'
    --   p_benefits       - New benefits description
    --   p_hard_deps      - New comma-separated hard dependency task_ids
    --   p_soft_deps      - New comma-separated soft dependency task_ids
    --
    -- Raises:
    --   e_task_not_found      - If the task_id does not exist
    --   e_self_dependency     - If dependencies reference the task itself
    --   e_circular_dependency - If dependencies would create a cycle
    ----------------------------------------------------------------------------
    PROCEDURE update_task(
        p_user_id        IN NUMBER,
        p_task_id        IN NUMBER,
        p_title          IN VARCHAR2,
        p_description    IN VARCHAR2,
        p_jira_ref       IN VARCHAR2,
        p_start_time     IN TIMESTAMP WITH TIME ZONE,
        p_duration       IN NUMBER,
        p_owner_dept_id  IN NUMBER,
        p_implementor_id IN NUMBER,
        p_impl_type      IN VARCHAR2,
        p_benefits       IN VARCHAR2,
        p_hard_deps      IN VARCHAR2,
        p_soft_deps      IN VARCHAR2
    );

    ----------------------------------------------------------------------------
    -- delete_task
    --
    -- Deletes a task and its associated dependencies. Only permitted when the
    -- parent MCR is in Draft or Review status. Records the deletion in the
    -- audit log.
    --
    -- Parameters:
    --   p_user_id - Numeric ID of the acting user
    --   p_task_id - ID of the task to delete
    --
    -- Raises:
    --   e_task_not_found - If the task_id does not exist
    ----------------------------------------------------------------------------
    PROCEDURE delete_task(
        p_user_id IN NUMBER,
        p_task_id IN NUMBER
    );

    ----------------------------------------------------------------------------
    -- get_tasks
    --
    -- Returns all tasks for a given MCR with dependency information as JSON
    -- via APEX_JSON output.
    --
    -- Parameters:
    --   p_mcr_id - MCR identifier to retrieve tasks for
    ----------------------------------------------------------------------------
    PROCEDURE get_tasks(
        p_mcr_id IN NUMBER
    );

    ----------------------------------------------------------------------------
    -- change_task_status
    --
    -- Changes the status of a task after validating that the acting user has
    -- permission (Management Group, Owning Team, or task Author). Records the
    -- status change in the audit log.
    --
    -- Parameters:
    --   p_user_id    - Numeric ID of the acting user
    --   p_task_id    - ID of the task to update
    --   p_new_status - New status value (Blocked, Ready, Complete, Cancelled,
    --                  Failed)
    --
    -- Raises:
    --   e_task_not_found    - If the task_id does not exist
    --   e_insufficient_perm - If the user lacks permission to change status
    ----------------------------------------------------------------------------
    PROCEDURE change_task_status(
        p_user_id    IN NUMBER,
        p_task_id    IN NUMBER,
        p_new_status IN VARCHAR2
    );

    ----------------------------------------------------------------------------
    -- get_dependency_map
    --
    -- Returns task nodes and dependency edges for an MCR as JSON, suitable
    -- for rendering a directed dependency graph. Includes task status, title,
    -- and dependency types.
    --
    -- Parameters:
    --   p_mcr_id - MCR identifier to build the dependency map for
    ----------------------------------------------------------------------------
    PROCEDURE get_dependency_map(
        p_mcr_id IN NUMBER
    );

    ----------------------------------------------------------------------------
    -- get_actions
    --
    -- Returns all actions for a given task in execution order (by
    -- ordinal_position) as JSON via APEX_JSON output.
    --
    -- Parameters:
    --   p_task_id - Task identifier to retrieve actions for
    ----------------------------------------------------------------------------
    PROCEDURE get_actions(
        p_task_id IN NUMBER
    );

    ----------------------------------------------------------------------------
    -- create_action
    --
    -- Creates a new action step within a task. Assigns the next ordinal
    -- position (max + 1) and records the creation in the audit log.
    --
    -- Parameters:
    --   p_user_id     - Numeric ID of the acting user
    --   p_task_id     - Parent task identifier
    --   p_title       - Short title describing the action step
    --   p_description - Detailed description of the action
    ----------------------------------------------------------------------------
    PROCEDURE create_action(
        p_user_id     IN NUMBER,
        p_task_id     IN NUMBER,
        p_title       IN VARCHAR2,
        p_description IN VARCHAR2
    );

    ----------------------------------------------------------------------------
    -- update_action
    --
    -- Updates an existing action's title and description. Records the change
    -- in the audit log with old and new values.
    --
    -- Parameters:
    --   p_user_id     - Numeric ID of the acting user
    --   p_action_id   - ID of the action to update
    --   p_title       - New title value
    --   p_description - New description value
    ----------------------------------------------------------------------------
    PROCEDURE update_action(
        p_user_id     IN NUMBER,
        p_action_id   IN NUMBER,
        p_title       IN VARCHAR2,
        p_description IN VARCHAR2
    );

    ----------------------------------------------------------------------------
    -- delete_action
    --
    -- Deletes an action and reorders remaining actions to maintain contiguous
    -- ordinal positions. Records the deletion in the audit log.
    --
    -- Parameters:
    --   p_user_id   - Numeric ID of the acting user
    --   p_action_id - ID of the action to delete
    ----------------------------------------------------------------------------
    PROCEDURE delete_action(
        p_user_id   IN NUMBER,
        p_action_id IN NUMBER
    );

    ----------------------------------------------------------------------------
    -- update_action_statuses
    --
    -- Batch updates action statuses for a task with an optional comment.
    -- Validates that the acting user is in the Management Group or Owning
    -- Team. Records each status change in the audit log, including the
    -- comment if provided.
    --
    -- Parameters:
    --   p_user_id      - Numeric ID of the acting user
    --   p_task_id      - Parent task identifier
    --   p_statuses_json - CLOB containing JSON array of action status updates
    --                     (each element: {action_id, status})
    --   p_comment      - Optional comment accompanying the status changes
    --
    -- Raises:
    --   e_insufficient_perm - If the user lacks permission to update statuses
    ----------------------------------------------------------------------------
    PROCEDURE update_action_statuses(
        p_user_id       IN NUMBER,
        p_task_id       IN NUMBER,
        p_statuses_json IN CLOB,
        p_comment       IN VARCHAR2
    );

    ----------------------------------------------------------------------------
    -- validate_dependencies
    --
    -- Validates that the proposed hard and soft dependencies for a task do not
    -- create self-references or circular dependency chains. Uses a recursive
    -- CTE to traverse the existing dependency graph.
    --
    -- Parameters:
    --   p_mcr_id    - MCR identifier (scope for dependency validation)
    --   p_task_id   - Task being validated (or NULL for a new task)
    --   p_hard_deps - Comma-separated list of hard dependency task_ids
    --   p_soft_deps - Comma-separated list of soft dependency task_ids
    --
    -- Returns:
    --   TRUE if dependencies are valid (no self-ref or cycle), FALSE otherwise
    --
    -- Raises:
    --   e_self_dependency     - If any dependency references the task itself
    --   e_circular_dependency - If adding dependencies would create a cycle
    ----------------------------------------------------------------------------
    FUNCTION validate_dependencies(
        p_mcr_id    IN NUMBER,
        p_task_id   IN NUMBER,
        p_hard_deps IN VARCHAR2,
        p_soft_deps IN VARCHAR2
    ) RETURN BOOLEAN;

END pkg_mcr_tasks;
/
