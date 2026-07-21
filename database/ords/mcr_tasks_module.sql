/*
** mcr_tasks_module.sql
** ORDS REST Module: mcr_tasks
** Base Path: /mcr/v1/tasks/
**
** Handles MCR task CRUD, status changes, and dependency map retrieval.
** Requirements: 4.3, 4.8, 8.4, 9.5
*/

BEGIN
    ORDS.DEFINE_MODULE(
        p_module_name    => 'mcr_tasks',
        p_base_path      => '/mcr/v1/tasks/',
        p_items_per_page => 0,
        p_status         => 'PUBLISHED',
        p_comments       => 'MCR Task CRUD, status changes, and dependency map'
    );

    ---------------------------------------------------------------------------
    -- Template: :mcr_id
    -- GET  - List all tasks for an MCR
    -- POST - Create a new task within an MCR
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_tasks',
        p_pattern        => ':mcr_id',
        p_comments       => 'Task list and creation for a given MCR'
    );

    -- GET /mcr/v1/tasks/:mcr_id
    -- Returns all tasks for the specified MCR
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_tasks',
        p_pattern        => ':mcr_id',
        p_method         => 'GET',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user_id NUMBER;
BEGIN
    l_user_id := :\"X-User-Id\";

    IF l_user_id IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.OPEN_OBJECT('error');
        APEX_JSON.WRITE('code', 'AUTH_FAILED');
        APEX_JSON.WRITE('message', 'X-User-Id header is required');
        APEX_JSON.CLOSE_OBJECT;
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    PKG_MCR_TASKS.get_tasks(p_mcr_id => :mcr_id);
END;
]',
        p_comments       => 'GET handler - returns all tasks for an MCR'
    );

    -- POST /mcr/v1/tasks/:mcr_id
    -- Creates a new task within the specified MCR
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_tasks',
        p_pattern        => ':mcr_id',
        p_method         => 'POST',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user_id        NUMBER;
    l_body           CLOB;
    l_title          VARCHAR2(500);
    l_description    VARCHAR2(4000);
    l_jira_ref       VARCHAR2(100);
    l_start_time     TIMESTAMP WITH TIME ZONE;
    l_duration       NUMBER;
    l_owner_dept_id  NUMBER;
    l_implementor_id NUMBER;
    l_impl_type      VARCHAR2(20);
    l_benefits       VARCHAR2(4000);
    l_hard_deps      VARCHAR2(4000);
    l_soft_deps      VARCHAR2(4000);
BEGIN
    l_user_id := :\"X-User-Id\";

    IF l_user_id IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.OPEN_OBJECT('error');
        APEX_JSON.WRITE('code', 'AUTH_FAILED');
        APEX_JSON.WRITE('message', 'X-User-Id header is required');
        APEX_JSON.CLOSE_OBJECT;
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Parse JSON request body
    l_body := :body_text;
    APEX_JSON.PARSE(l_body);

    l_title          := APEX_JSON.GET_VARCHAR2(p_path => 'title');
    l_description    := APEX_JSON.GET_VARCHAR2(p_path => 'description');
    l_jira_ref       := APEX_JSON.GET_VARCHAR2(p_path => 'jira_reference');
    l_start_time     := TO_TIMESTAMP_TZ(
                            APEX_JSON.GET_VARCHAR2(p_path => 'start_time'),
                            'YYYY-MM-DD"T"HH24:MI:SS.FFTZHTZM'
                        );
    l_duration       := APEX_JSON.GET_NUMBER(p_path => 'estimated_duration_mins');
    l_owner_dept_id  := APEX_JSON.GET_NUMBER(p_path => 'owner_dept_id');
    l_implementor_id := APEX_JSON.GET_NUMBER(p_path => 'implementor_id');
    l_impl_type      := APEX_JSON.GET_VARCHAR2(p_path => 'implementor_type');
    l_benefits       := APEX_JSON.GET_VARCHAR2(p_path => 'benefits');
    l_hard_deps      := APEX_JSON.GET_VARCHAR2(p_path => 'hard_dependencies');
    l_soft_deps      := APEX_JSON.GET_VARCHAR2(p_path => 'soft_dependencies');

    PKG_MCR_TASKS.create_task(
        p_user_id        => l_user_id,
        p_mcr_id         => :mcr_id,
        p_title          => l_title,
        p_description    => l_description,
        p_jira_ref       => l_jira_ref,
        p_start_time     => l_start_time,
        p_duration       => l_duration,
        p_owner_dept_id  => l_owner_dept_id,
        p_implementor_id => l_implementor_id,
        p_impl_type      => l_impl_type,
        p_benefits       => l_benefits,
        p_hard_deps      => l_hard_deps,
        p_soft_deps      => l_soft_deps
    );

    OWA_UTIL.STATUS_LINE(201, 'Created');
EXCEPTION
    WHEN PKG_MCR_TASKS.e_self_dependency THEN
        OWA_UTIL.STATUS_LINE(400, 'Bad Request');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.OPEN_OBJECT('error');
        APEX_JSON.WRITE('code', 'SELF_DEPENDENCY');
        APEX_JSON.WRITE('message', SQLERRM);
        APEX_JSON.CLOSE_OBJECT;
        APEX_JSON.CLOSE_OBJECT;
    WHEN PKG_MCR_TASKS.e_circular_dependency THEN
        OWA_UTIL.STATUS_LINE(400, 'Bad Request');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.OPEN_OBJECT('error');
        APEX_JSON.WRITE('code', 'CIRCULAR_DEPENDENCY');
        APEX_JSON.WRITE('message', SQLERRM);
        APEX_JSON.CLOSE_OBJECT;
        APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'POST handler - creates a new task within an MCR'
    );

    ---------------------------------------------------------------------------
    -- Template: :task_id
    -- PUT    - Update an existing task
    -- DELETE - Delete a task
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_tasks',
        p_pattern        => ':task_id',
        p_comments       => 'Task update and deletion by task ID'
    );

    -- PUT /mcr/v1/tasks/:task_id
    -- Updates an existing task
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_tasks',
        p_pattern        => ':task_id',
        p_method         => 'PUT',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user_id        NUMBER;
    l_body           CLOB;
    l_title          VARCHAR2(500);
    l_description    VARCHAR2(4000);
    l_jira_ref       VARCHAR2(100);
    l_start_time     TIMESTAMP WITH TIME ZONE;
    l_duration       NUMBER;
    l_owner_dept_id  NUMBER;
    l_implementor_id NUMBER;
    l_impl_type      VARCHAR2(20);
    l_benefits       VARCHAR2(4000);
    l_hard_deps      VARCHAR2(4000);
    l_soft_deps      VARCHAR2(4000);
BEGIN
    l_user_id := :\"X-User-Id\";

    IF l_user_id IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.OPEN_OBJECT('error');
        APEX_JSON.WRITE('code', 'AUTH_FAILED');
        APEX_JSON.WRITE('message', 'X-User-Id header is required');
        APEX_JSON.CLOSE_OBJECT;
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Parse JSON request body
    l_body := :body_text;
    APEX_JSON.PARSE(l_body);

    l_title          := APEX_JSON.GET_VARCHAR2(p_path => 'title');
    l_description    := APEX_JSON.GET_VARCHAR2(p_path => 'description');
    l_jira_ref       := APEX_JSON.GET_VARCHAR2(p_path => 'jira_reference');
    l_start_time     := TO_TIMESTAMP_TZ(
                            APEX_JSON.GET_VARCHAR2(p_path => 'start_time'),
                            'YYYY-MM-DD"T"HH24:MI:SS.FFTZHTZM'
                        );
    l_duration       := APEX_JSON.GET_NUMBER(p_path => 'estimated_duration_mins');
    l_owner_dept_id  := APEX_JSON.GET_NUMBER(p_path => 'owner_dept_id');
    l_implementor_id := APEX_JSON.GET_NUMBER(p_path => 'implementor_id');
    l_impl_type      := APEX_JSON.GET_VARCHAR2(p_path => 'implementor_type');
    l_benefits       := APEX_JSON.GET_VARCHAR2(p_path => 'benefits');
    l_hard_deps      := APEX_JSON.GET_VARCHAR2(p_path => 'hard_dependencies');
    l_soft_deps      := APEX_JSON.GET_VARCHAR2(p_path => 'soft_dependencies');

    PKG_MCR_TASKS.update_task(
        p_user_id        => l_user_id,
        p_task_id        => :task_id,
        p_title          => l_title,
        p_description    => l_description,
        p_jira_ref       => l_jira_ref,
        p_start_time     => l_start_time,
        p_duration       => l_duration,
        p_owner_dept_id  => l_owner_dept_id,
        p_implementor_id => l_implementor_id,
        p_impl_type      => l_impl_type,
        p_benefits       => l_benefits,
        p_hard_deps      => l_hard_deps,
        p_soft_deps      => l_soft_deps
    );
EXCEPTION
    WHEN PKG_MCR_TASKS.e_task_not_found THEN
        OWA_UTIL.STATUS_LINE(404, 'Not Found');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.OPEN_OBJECT('error');
        APEX_JSON.WRITE('code', 'TASK_NOT_FOUND');
        APEX_JSON.WRITE('message', SQLERRM);
        APEX_JSON.CLOSE_OBJECT;
        APEX_JSON.CLOSE_OBJECT;
    WHEN PKG_MCR_TASKS.e_self_dependency THEN
        OWA_UTIL.STATUS_LINE(400, 'Bad Request');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.OPEN_OBJECT('error');
        APEX_JSON.WRITE('code', 'SELF_DEPENDENCY');
        APEX_JSON.WRITE('message', SQLERRM);
        APEX_JSON.CLOSE_OBJECT;
        APEX_JSON.CLOSE_OBJECT;
    WHEN PKG_MCR_TASKS.e_circular_dependency THEN
        OWA_UTIL.STATUS_LINE(400, 'Bad Request');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.OPEN_OBJECT('error');
        APEX_JSON.WRITE('code', 'CIRCULAR_DEPENDENCY');
        APEX_JSON.WRITE('message', SQLERRM);
        APEX_JSON.CLOSE_OBJECT;
        APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'PUT handler - updates an existing task'
    );

    -- DELETE /mcr/v1/tasks/:task_id
    -- Deletes a task (only permitted in Draft/Review states)
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_tasks',
        p_pattern        => ':task_id',
        p_method         => 'DELETE',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user_id NUMBER;
BEGIN
    l_user_id := :\"X-User-Id\";

    IF l_user_id IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.OPEN_OBJECT('error');
        APEX_JSON.WRITE('code', 'AUTH_FAILED');
        APEX_JSON.WRITE('message', 'X-User-Id header is required');
        APEX_JSON.CLOSE_OBJECT;
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    PKG_MCR_TASKS.delete_task(
        p_user_id => l_user_id,
        p_task_id => :task_id
    );
EXCEPTION
    WHEN PKG_MCR_TASKS.e_task_not_found THEN
        OWA_UTIL.STATUS_LINE(404, 'Not Found');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.OPEN_OBJECT('error');
        APEX_JSON.WRITE('code', 'TASK_NOT_FOUND');
        APEX_JSON.WRITE('message', SQLERRM);
        APEX_JSON.CLOSE_OBJECT;
        APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'DELETE handler - deletes a task'
    );

    ---------------------------------------------------------------------------
    -- Template: :task_id/status
    -- PUT - Change task status
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_tasks',
        p_pattern        => ':task_id/status',
        p_comments       => 'Task status change endpoint'
    );

    -- PUT /mcr/v1/tasks/:task_id/status
    -- Changes the status of a task with permission validation
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_tasks',
        p_pattern        => ':task_id/status',
        p_method         => 'PUT',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user_id    NUMBER;
    l_body       CLOB;
    l_new_status VARCHAR2(50);
BEGIN
    l_user_id := :\"X-User-Id\";

    IF l_user_id IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.OPEN_OBJECT('error');
        APEX_JSON.WRITE('code', 'AUTH_FAILED');
        APEX_JSON.WRITE('message', 'X-User-Id header is required');
        APEX_JSON.CLOSE_OBJECT;
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Parse JSON request body
    l_body := :body_text;
    APEX_JSON.PARSE(l_body);

    l_new_status := APEX_JSON.GET_VARCHAR2(p_path => 'new_status');

    PKG_MCR_TASKS.change_task_status(
        p_user_id    => l_user_id,
        p_task_id    => :task_id,
        p_new_status => l_new_status
    );
EXCEPTION
    WHEN PKG_MCR_TASKS.e_task_not_found THEN
        OWA_UTIL.STATUS_LINE(404, 'Not Found');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.OPEN_OBJECT('error');
        APEX_JSON.WRITE('code', 'TASK_NOT_FOUND');
        APEX_JSON.WRITE('message', SQLERRM);
        APEX_JSON.CLOSE_OBJECT;
        APEX_JSON.CLOSE_OBJECT;
    WHEN PKG_MCR_TASKS.e_insufficient_perm THEN
        OWA_UTIL.STATUS_LINE(403, 'Forbidden');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.OPEN_OBJECT('error');
        APEX_JSON.WRITE('code', 'INSUFFICIENT_PERMISSION');
        APEX_JSON.WRITE('message', SQLERRM);
        APEX_JSON.CLOSE_OBJECT;
        APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'PUT handler - changes task status with permission check'
    );

    ---------------------------------------------------------------------------
    -- Template: :mcr_id/dependency-map
    -- GET - Retrieve the dependency graph for an MCR
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_tasks',
        p_pattern        => ':mcr_id/dependency-map',
        p_comments       => 'Dependency map visualization data'
    );

    -- GET /mcr/v1/tasks/:mcr_id/dependency-map
    -- Returns task nodes and dependency edges for graph rendering
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_tasks',
        p_pattern        => ':mcr_id/dependency-map',
        p_method         => 'GET',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user_id NUMBER;
BEGIN
    l_user_id := :\"X-User-Id\";

    IF l_user_id IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.OPEN_OBJECT('error');
        APEX_JSON.WRITE('code', 'AUTH_FAILED');
        APEX_JSON.WRITE('message', 'X-User-Id header is required');
        APEX_JSON.CLOSE_OBJECT;
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    PKG_MCR_TASKS.get_dependency_map(p_mcr_id => :mcr_id);
END;
]',
        p_comments       => 'GET handler - returns dependency graph nodes and edges'
    );

    COMMIT;
END;
/
