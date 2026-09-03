CREATE OR REPLACE PACKAGE pkg_mcr_tasks AS
    /*
    ** PKG_MCR_TASKS
    ** Task CRUD, dependency validation, task status management, action
    ** management, and dependency cascade for MCR Manager.
    **
    ** Requirements 4.3, 4.4, 4.5, 5.3: Task operations with dependency
    ** validation, sequential ordering, action management, and cascade logic.
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
    -- the parent MCR is Approved, and records the change in the audit log.
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
    -- parent MCR is in Draft or Review status.
    ----------------------------------------------------------------------------
    PROCEDURE delete_task(
        p_user_id IN NUMBER,
        p_task_id IN NUMBER
    );

    ----------------------------------------------------------------------------
    -- get_tasks
    --
    -- Returns all tasks for a given MCR with dependency information as JSON.
    ----------------------------------------------------------------------------
    PROCEDURE get_tasks(
        p_mcr_id IN NUMBER
    );

    ----------------------------------------------------------------------------
    -- change_task_status
    --
    -- Changes the status of a task after validating that the acting user has
    -- permission (Management Group, Owning Team, or task Author).
    ----------------------------------------------------------------------------
    PROCEDURE change_task_status(
        p_user_id    IN NUMBER,
        p_task_id    IN NUMBER,
        p_new_status IN VARCHAR2
    );

    ----------------------------------------------------------------------------
    -- cascade_cancel_deps
    --
    -- Handles dependency cascading when a task is Cancelled or Failed.
    -- For tasks that have a HARD dependency on p_task_id:
    --   If p_convert_to_soft = TRUE: converts the HARD dep to SOFT
    --     (dependency becomes "Any Status" instead of "Must Succeed")
    --   If p_convert_to_soft = FALSE: sets affected tasks to Blocked_Dep status
    --
    -- Parameters:
    --   p_task_id         - The task that was cancelled/failed
    --   p_convert_to_soft - TRUE to convert hard deps to soft, FALSE to block
    ----------------------------------------------------------------------------
    PROCEDURE cascade_cancel_deps(
        p_task_id         IN NUMBER,
        p_convert_to_soft IN BOOLEAN DEFAULT FALSE
    );

    ----------------------------------------------------------------------------
    -- get_dependency_map
    --
    -- Returns task nodes and dependency edges for an MCR as JSON.
    ----------------------------------------------------------------------------
    PROCEDURE get_dependency_map(
        p_mcr_id IN NUMBER
    );

    ----------------------------------------------------------------------------
    -- get_actions
    --
    -- Returns all actions for a given task in execution order.
    ----------------------------------------------------------------------------
    PROCEDURE get_actions(
        p_task_id IN NUMBER
    );

    ----------------------------------------------------------------------------
    -- create_action
    --
    -- Creates a new action step within a task.
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
    -- Updates an existing action's title and description.
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
    -- Deletes an action and reorders remaining actions.
    ----------------------------------------------------------------------------
    PROCEDURE delete_action(
        p_user_id   IN NUMBER,
        p_action_id IN NUMBER
    );

    ----------------------------------------------------------------------------
    -- update_action_statuses
    --
    -- Batch updates action statuses for a task with an optional comment.
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
    -- Validates that proposed dependencies do not create self-references or
    -- circular dependency chains.
    ----------------------------------------------------------------------------
    FUNCTION validate_dependencies(
        p_mcr_id    IN NUMBER,
        p_task_id   IN NUMBER,
        p_hard_deps IN VARCHAR2,
        p_soft_deps IN VARCHAR2
    ) RETURN BOOLEAN;

END pkg_mcr_tasks;
/
