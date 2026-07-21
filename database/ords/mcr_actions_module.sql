/*
** mcr_actions_module.sql
** ORDS REST Module: mcr_actions
** Base Path: /mcr/v1/actions/
**
** Handles CRUD operations for task actions and batch status updates.
** Actions are ordered steps within an MCR task that define the execution plan.
** Requirements: 5.3, 5.4, 8.6, 8.9
*/

BEGIN
    ORDS.DEFINE_MODULE(
        p_module_name    => 'mcr_actions',
        p_base_path      => '/mcr/v1/actions/',
        p_items_per_page => 0,
        p_status         => 'PUBLISHED',
        p_comments       => 'MCR Task Actions CRUD and batch status updates'
    );

    ---------------------------------------------------------------------------
    -- Template: :task_id
    -- GET  - List actions for a task
    -- POST - Create a new action within a task
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_actions',
        p_pattern        => ':task_id',
        p_comments       => 'Get and create actions for a task'
    );

    ---------------------------------------------------------------------------
    -- GET /mcr/v1/actions/:task_id
    -- Returns all actions for the specified task in execution order
    ---------------------------------------------------------------------------
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_actions',
        p_pattern        => ':task_id',
        p_method         => 'GET',
        p_source_type    => 'plsql/block',
        p_source         => q'[
BEGIN
    PKG_MCR_TASKS.get_actions(
        p_task_id => :task_id
    );
END;
]',
        p_comments       => 'GET handler - returns actions for a task in ordinal order'
    );

    ---------------------------------------------------------------------------
    -- POST /mcr/v1/actions/:task_id
    -- Creates a new action within the specified task
    -- Body: { "title": "...", "description": "..." }
    ---------------------------------------------------------------------------
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_actions',
        p_pattern        => ':task_id',
        p_method         => 'POST',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user_id     NUMBER;
    l_body        CLOB;
    l_title       VARCHAR2(500);
    l_description VARCHAR2(4000);
BEGIN
    l_user_id := :\"X-User-Id\";

    IF l_user_id IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.OPEN_OBJECT('error');
        APEX_JSON.WRITE('code', 'AUTH_REQUIRED');
        APEX_JSON.WRITE('message', 'X-User-Id header is required');
        APEX_JSON.CLOSE_OBJECT;
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    l_body := :body_text;
    APEX_JSON.PARSE(l_body);

    l_title       := APEX_JSON.GET_VARCHAR2(p_path => 'title');
    l_description := APEX_JSON.GET_VARCHAR2(p_path => 'description');

    PKG_MCR_TASKS.create_action(
        p_user_id     => l_user_id,
        p_task_id     => :task_id,
        p_title       => l_title,
        p_description => l_description
    );
END;
]',
        p_comments       => 'POST handler - creates a new action for the task'
    );

    ---------------------------------------------------------------------------
    -- Template: :action_id
    -- PUT    - Update an action
    -- DELETE - Delete an action (reorders remaining)
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_actions',
        p_pattern        => ':action_id',
        p_comments       => 'Update and delete individual actions'
    );

    ---------------------------------------------------------------------------
    -- PUT /mcr/v1/actions/:action_id
    -- Updates an existing action's title and description
    -- Body: { "title": "...", "description": "..." }
    ---------------------------------------------------------------------------
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_actions',
        p_pattern        => ':action_id',
        p_method         => 'PUT',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user_id     NUMBER;
    l_body        CLOB;
    l_title       VARCHAR2(500);
    l_description VARCHAR2(4000);
BEGIN
    l_user_id := :\"X-User-Id\";

    IF l_user_id IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.OPEN_OBJECT('error');
        APEX_JSON.WRITE('code', 'AUTH_REQUIRED');
        APEX_JSON.WRITE('message', 'X-User-Id header is required');
        APEX_JSON.CLOSE_OBJECT;
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    l_body := :body_text;
    APEX_JSON.PARSE(l_body);

    l_title       := APEX_JSON.GET_VARCHAR2(p_path => 'title');
    l_description := APEX_JSON.GET_VARCHAR2(p_path => 'description');

    PKG_MCR_TASKS.update_action(
        p_user_id     => l_user_id,
        p_action_id   => :action_id,
        p_title       => l_title,
        p_description => l_description
    );
END;
]',
        p_comments       => 'PUT handler - updates action title and description'
    );

    ---------------------------------------------------------------------------
    -- DELETE /mcr/v1/actions/:action_id
    -- Deletes an action and reorders remaining actions
    ---------------------------------------------------------------------------
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_actions',
        p_pattern        => ':action_id',
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
        APEX_JSON.WRITE('code', 'AUTH_REQUIRED');
        APEX_JSON.WRITE('message', 'X-User-Id header is required');
        APEX_JSON.CLOSE_OBJECT;
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    PKG_MCR_TASKS.delete_action(
        p_user_id   => l_user_id,
        p_action_id => :action_id
    );
END;
]',
        p_comments       => 'DELETE handler - removes action and reorders remaining'
    );

    ---------------------------------------------------------------------------
    -- Template: :task_id/statuses
    -- PUT - Batch update action statuses with optional comment
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_actions',
        p_pattern        => ':task_id/statuses',
        p_comments       => 'Batch update action statuses for a task'
    );

    ---------------------------------------------------------------------------
    -- PUT /mcr/v1/actions/:task_id/statuses
    -- Batch updates action statuses with an optional comment
    -- Body: { "statuses": [...], "comment": "..." }
    ---------------------------------------------------------------------------
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_actions',
        p_pattern        => ':task_id/statuses',
        p_method         => 'PUT',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user_id       NUMBER;
    l_body          CLOB;
    l_statuses_json CLOB;
    l_comment       VARCHAR2(4000);
BEGIN
    l_user_id := :\"X-User-Id\";

    IF l_user_id IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.OPEN_OBJECT('error');
        APEX_JSON.WRITE('code', 'AUTH_REQUIRED');
        APEX_JSON.WRITE('message', 'X-User-Id header is required');
        APEX_JSON.CLOSE_OBJECT;
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    l_body := :body_text;
    APEX_JSON.PARSE(l_body);

    -- Extract the statuses array as a JSON string for the package to process
    l_statuses_json := APEX_JSON.GET_CLOB(p_path => 'statuses');
    l_comment       := APEX_JSON.GET_VARCHAR2(p_path => 'comment');

    PKG_MCR_TASKS.update_action_statuses(
        p_user_id       => l_user_id,
        p_task_id       => :task_id,
        p_statuses_json => l_statuses_json,
        p_comment       => l_comment
    );
END;
]',
        p_comments       => 'PUT handler - batch updates action statuses with comment'
    );

    COMMIT;
END;
/
