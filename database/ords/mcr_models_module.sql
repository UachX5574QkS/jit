/*
** mcr_models_module.sql
** ORDS REST Module: mcr_models
** Base Path: /mcr/v1/models/
**
** Handles MCR Models (template task lists) CRUD operations.
** Models allow reusable task templates that can be applied when creating MCRs.
** Requirements: Backlog item 9
*/

BEGIN
    ORDS.DEFINE_MODULE(
        p_module_name    => 'mcr_models',
        p_base_path      => '/mcr/v1/models/',
        p_items_per_page => 0,
        p_status         => 'PUBLISHED',
        p_comments       => 'MCR Models (template task lists) CRUD operations'
    );

    ---------------------------------------------------------------------------
    -- Template: . (root)
    -- GET: List all models with task count
    -- POST: Create a new model
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_models',
        p_pattern        => '.',
        p_comments       => 'List and create models'
    );

    -- GET /mcr/v1/models/
    -- Returns all models with task count
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_models',
        p_pattern        => '.',
        p_method         => 'GET',
        p_source_type    => 'json/collection',
        p_source         => q'[
            SELECT m.model_id,
                   m.model_name,
                   m.description,
                   m.created_by,
                   TO_CHAR(m.created_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS created_at,
                   (SELECT COUNT(*)
                      FROM tab_mcr_model_tasks mt
                     WHERE mt.model_id = m.model_id) AS task_count
              FROM tab_mcr_models m
             ORDER BY m.model_name
        ]',
        p_comments       => 'GET handler - list all models with task count'
    );

    -- POST /mcr/v1/models/
    -- Creates a new model
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_models',
        p_pattern        => '.',
        p_method         => 'POST',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_body        CLOB;
    l_model_name  VARCHAR2(255);
    l_description VARCHAR2(2000);
    l_created_by  NUMBER;
    l_model_id    NUMBER;
BEGIN
    l_body := :body_text;
    APEX_JSON.PARSE(l_body);

    l_model_name  := APEX_JSON.GET_VARCHAR2(p_path => 'model_name');
    l_description := APEX_JSON.GET_VARCHAR2(p_path => 'description');
    l_created_by  := APEX_JSON.GET_NUMBER(p_path => 'created_by');

    IF l_created_by IS NULL THEN
        l_created_by := TO_NUMBER(:"X-User-Id");
    END IF;

    IF l_model_name IS NULL THEN
        OWA_UTIL.STATUS_LINE(400, 'Bad Request');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'model_name is required');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    INSERT INTO tab_mcr_models (model_name, description, created_by)
    VALUES (l_model_name, l_description, l_created_by)
    RETURNING model_id INTO l_model_id;

    COMMIT;

    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.WRITE('model_id', l_model_id);
    APEX_JSON.WRITE('model_name', l_model_name);
    APEX_JSON.WRITE('status', 'created');
    APEX_JSON.CLOSE_OBJECT;

EXCEPTION
    WHEN DUP_VAL_ON_INDEX THEN
        OWA_UTIL.STATUS_LINE(409, 'Conflict');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'A model with this name already exists');
        APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'POST handler - create a new model'
    );

    ---------------------------------------------------------------------------
    -- Template: :model_id
    -- GET: Get model with nested tasks
    -- PUT: Update model name/description
    -- DELETE: Delete model and its tasks
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_models',
        p_pattern        => ':model_id',
        p_comments       => 'Single model operations (get with tasks, update, delete)'
    );

    -- GET /mcr/v1/models/:model_id
    -- Returns model details with nested tasks array
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_models',
        p_pattern        => ':model_id',
        p_method         => 'GET',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_model_id    NUMBER;
    l_model_name  VARCHAR2(255);
    l_description VARCHAR2(2000);
    l_created_by  NUMBER;
    l_created_at  TIMESTAMP WITH TIME ZONE;
BEGIN
    l_model_id := TO_NUMBER(:model_id);

    BEGIN
        SELECT model_name, description, created_by, created_at
          INTO l_model_name, l_description, l_created_by, l_created_at
          FROM tab_mcr_models
         WHERE model_id = l_model_id;
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            OWA_UTIL.STATUS_LINE(404, 'Not Found');
            APEX_JSON.OPEN_OBJECT;
            APEX_JSON.WRITE('error', 'Model not found');
            APEX_JSON.CLOSE_OBJECT;
            RETURN;
    END;

    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.WRITE('model_id', l_model_id);
    APEX_JSON.WRITE('model_name', l_model_name);
    APEX_JSON.WRITE('description', l_description);
    APEX_JSON.WRITE('created_by', l_created_by);
    APEX_JSON.WRITE('created_at', TO_CHAR(l_created_at, 'YYYY-MM-DD"T"HH24:MI:SS'));

    -- Nested tasks array
    APEX_JSON.OPEN_ARRAY('tasks');
    FOR rec IN (
        SELECT model_task_id, task_seq, title, description,
               owner_dept_id, implementor_id, implementor_type,
               benefits, sub_actions, backout_plan,
               estimated_duration_mins, soft_dep_seqs, hard_dep_seqs
          FROM tab_mcr_model_tasks
         WHERE model_id = l_model_id
         ORDER BY task_seq
    ) LOOP
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('model_task_id', rec.model_task_id);
        APEX_JSON.WRITE('task_seq', rec.task_seq);
        APEX_JSON.WRITE('title', rec.title);
        APEX_JSON.WRITE('description', rec.description);
        APEX_JSON.WRITE('owner_dept_id', rec.owner_dept_id);
        APEX_JSON.WRITE('implementor_id', rec.implementor_id);
        APEX_JSON.WRITE('implementor_type', rec.implementor_type);
        APEX_JSON.WRITE('benefits', rec.benefits);
        APEX_JSON.WRITE('sub_actions', rec.sub_actions);
        APEX_JSON.WRITE('backout_plan', rec.backout_plan);
        APEX_JSON.WRITE('estimated_duration_mins', rec.estimated_duration_mins);
        APEX_JSON.WRITE('soft_dep_seqs', rec.soft_dep_seqs);
        APEX_JSON.WRITE('hard_dep_seqs', rec.hard_dep_seqs);
        APEX_JSON.CLOSE_OBJECT;
    END LOOP;
    APEX_JSON.CLOSE_ARRAY;

    APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'GET handler - get model with tasks'
    );

    -- PUT /mcr/v1/models/:model_id
    -- Update model name and/or description
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_models',
        p_pattern        => ':model_id',
        p_method         => 'PUT',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_model_id    NUMBER;
    l_body        CLOB;
    l_model_name  VARCHAR2(255);
    l_description VARCHAR2(2000);
    l_rows        NUMBER;
BEGIN
    l_model_id := TO_NUMBER(:model_id);
    l_body := :body_text;
    APEX_JSON.PARSE(l_body);

    l_model_name  := APEX_JSON.GET_VARCHAR2(p_path => 'model_name');
    l_description := APEX_JSON.GET_VARCHAR2(p_path => 'description');

    UPDATE tab_mcr_models
       SET model_name  = NVL(l_model_name, model_name),
           description = NVL(l_description, description)
     WHERE model_id = l_model_id;

    l_rows := SQL%ROWCOUNT;
    COMMIT;

    IF l_rows = 0 THEN
        OWA_UTIL.STATUS_LINE(404, 'Not Found');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'Model not found');
        APEX_JSON.CLOSE_OBJECT;
    ELSE
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('model_id', l_model_id);
        APEX_JSON.WRITE('status', 'updated');
        APEX_JSON.CLOSE_OBJECT;
    END IF;

EXCEPTION
    WHEN DUP_VAL_ON_INDEX THEN
        OWA_UTIL.STATUS_LINE(409, 'Conflict');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'A model with this name already exists');
        APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'PUT handler - update model name/description'
    );

    -- DELETE /mcr/v1/models/:model_id
    -- Delete model (CASCADE deletes tasks)
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_models',
        p_pattern        => ':model_id',
        p_method         => 'DELETE',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_model_id NUMBER;
    l_rows     NUMBER;
BEGIN
    l_model_id := TO_NUMBER(:model_id);

    -- Delete tasks first (explicit, in case FK lacks ON DELETE CASCADE)
    DELETE FROM tab_mcr_model_tasks WHERE model_id = l_model_id;

    DELETE FROM tab_mcr_models WHERE model_id = l_model_id;
    l_rows := SQL%ROWCOUNT;
    COMMIT;

    IF l_rows = 0 THEN
        OWA_UTIL.STATUS_LINE(404, 'Not Found');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'Model not found');
        APEX_JSON.CLOSE_OBJECT;
    ELSE
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('model_id', l_model_id);
        APEX_JSON.WRITE('status', 'deleted');
        APEX_JSON.CLOSE_OBJECT;
    END IF;
END;
]',
        p_comments       => 'DELETE handler - delete model and its tasks'
    );

    ---------------------------------------------------------------------------
    -- Template: :model_id/tasks
    -- POST: Create a model task
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_models',
        p_pattern        => ':model_id/tasks',
        p_comments       => 'Create model tasks for a specific model'
    );

    -- POST /mcr/v1/models/:model_id/tasks
    -- Create a new model task with auto-assigned task_seq
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_models',
        p_pattern        => ':model_id/tasks',
        p_method         => 'POST',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_model_id         NUMBER;
    l_body             CLOB;
    l_title            VARCHAR2(500);
    l_description      VARCHAR2(4000);
    l_owner_dept_id    NUMBER;
    l_implementor_id   NUMBER;
    l_implementor_type VARCHAR2(20);
    l_benefits         VARCHAR2(4000);
    l_sub_actions      CLOB;
    l_backout_plan     CLOB;
    l_duration_mins    NUMBER;
    l_soft_dep_seqs    VARCHAR2(1000);
    l_hard_dep_seqs    VARCHAR2(1000);
    l_task_seq         NUMBER;
    l_model_task_id    NUMBER;
    l_model_exists     NUMBER;
BEGIN
    l_model_id := TO_NUMBER(:model_id);

    -- Check model exists
    SELECT COUNT(*) INTO l_model_exists
      FROM tab_mcr_models WHERE model_id = l_model_id;

    IF l_model_exists = 0 THEN
        OWA_UTIL.STATUS_LINE(404, 'Not Found');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'Model not found');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    l_body := :body_text;
    APEX_JSON.PARSE(l_body);

    l_title            := APEX_JSON.GET_VARCHAR2(p_path => 'title');
    l_description      := APEX_JSON.GET_VARCHAR2(p_path => 'description');
    l_owner_dept_id    := APEX_JSON.GET_NUMBER(p_path => 'owner_dept_id');
    l_implementor_id   := APEX_JSON.GET_NUMBER(p_path => 'implementor_id');
    l_implementor_type := APEX_JSON.GET_VARCHAR2(p_path => 'implementor_type');
    l_benefits         := APEX_JSON.GET_VARCHAR2(p_path => 'benefits');
    l_sub_actions      := APEX_JSON.GET_CLOB(p_path => 'sub_actions');
    l_backout_plan     := APEX_JSON.GET_CLOB(p_path => 'backout_plan');
    l_duration_mins    := APEX_JSON.GET_NUMBER(p_path => 'estimated_duration_mins');
    l_soft_dep_seqs    := APEX_JSON.GET_VARCHAR2(p_path => 'soft_dep_seqs');
    l_hard_dep_seqs    := APEX_JSON.GET_VARCHAR2(p_path => 'hard_dep_seqs');

    IF l_title IS NULL THEN
        OWA_UTIL.STATUS_LINE(400, 'Bad Request');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'title is required');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Auto-assign task_seq (MAX + 1)
    SELECT NVL(MAX(task_seq), 0) + 1
      INTO l_task_seq
      FROM tab_mcr_model_tasks
     WHERE model_id = l_model_id;

    INSERT INTO tab_mcr_model_tasks (
        model_id, task_seq, title, description,
        owner_dept_id, implementor_id, implementor_type,
        benefits, sub_actions, backout_plan,
        estimated_duration_mins, soft_dep_seqs, hard_dep_seqs
    ) VALUES (
        l_model_id, l_task_seq, l_title, l_description,
        l_owner_dept_id, l_implementor_id, l_implementor_type,
        l_benefits, l_sub_actions, l_backout_plan,
        l_duration_mins, l_soft_dep_seqs, l_hard_dep_seqs
    ) RETURNING model_task_id INTO l_model_task_id;

    COMMIT;

    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.WRITE('model_task_id', l_model_task_id);
    APEX_JSON.WRITE('task_seq', l_task_seq);
    APEX_JSON.WRITE('status', 'created');
    APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'POST handler - create model task with auto-assigned sequence'
    );

    ---------------------------------------------------------------------------
    -- Template: tasks/:model_task_id
    -- PUT: Update a model task
    -- DELETE: Delete a model task
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_models',
        p_pattern        => 'tasks/:model_task_id',
        p_comments       => 'Update and delete individual model tasks'
    );

    -- PUT /mcr/v1/models/tasks/:model_task_id
    -- Update a model task
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_models',
        p_pattern        => 'tasks/:model_task_id',
        p_method         => 'PUT',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_model_task_id    NUMBER;
    l_body             CLOB;
    l_title            VARCHAR2(500);
    l_description      VARCHAR2(4000);
    l_owner_dept_id    NUMBER;
    l_implementor_id   NUMBER;
    l_implementor_type VARCHAR2(20);
    l_benefits         VARCHAR2(4000);
    l_sub_actions      CLOB;
    l_backout_plan     CLOB;
    l_duration_mins    NUMBER;
    l_soft_dep_seqs    VARCHAR2(1000);
    l_hard_dep_seqs    VARCHAR2(1000);
    l_rows             NUMBER;
BEGIN
    l_model_task_id := TO_NUMBER(:model_task_id);
    l_body := :body_text;
    APEX_JSON.PARSE(l_body);

    l_title            := APEX_JSON.GET_VARCHAR2(p_path => 'title');
    l_description      := APEX_JSON.GET_VARCHAR2(p_path => 'description');
    l_owner_dept_id    := APEX_JSON.GET_NUMBER(p_path => 'owner_dept_id');
    l_implementor_id   := APEX_JSON.GET_NUMBER(p_path => 'implementor_id');
    l_implementor_type := APEX_JSON.GET_VARCHAR2(p_path => 'implementor_type');
    l_benefits         := APEX_JSON.GET_VARCHAR2(p_path => 'benefits');
    l_sub_actions      := APEX_JSON.GET_CLOB(p_path => 'sub_actions');
    l_backout_plan     := APEX_JSON.GET_CLOB(p_path => 'backout_plan');
    l_duration_mins    := APEX_JSON.GET_NUMBER(p_path => 'estimated_duration_mins');
    l_soft_dep_seqs    := APEX_JSON.GET_VARCHAR2(p_path => 'soft_dep_seqs');
    l_hard_dep_seqs    := APEX_JSON.GET_VARCHAR2(p_path => 'hard_dep_seqs');

    UPDATE tab_mcr_model_tasks
       SET title                  = NVL(l_title, title),
           description            = NVL(l_description, description),
           owner_dept_id          = NVL(l_owner_dept_id, owner_dept_id),
           implementor_id         = NVL(l_implementor_id, implementor_id),
           implementor_type       = NVL(l_implementor_type, implementor_type),
           benefits               = NVL(l_benefits, benefits),
           sub_actions            = NVL(l_sub_actions, sub_actions),
           backout_plan           = NVL(l_backout_plan, backout_plan),
           estimated_duration_mins = NVL(l_duration_mins, estimated_duration_mins),
           soft_dep_seqs          = NVL(l_soft_dep_seqs, soft_dep_seqs),
           hard_dep_seqs          = NVL(l_hard_dep_seqs, hard_dep_seqs)
     WHERE model_task_id = l_model_task_id;

    l_rows := SQL%ROWCOUNT;
    COMMIT;

    IF l_rows = 0 THEN
        OWA_UTIL.STATUS_LINE(404, 'Not Found');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'Model task not found');
        APEX_JSON.CLOSE_OBJECT;
    ELSE
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('model_task_id', l_model_task_id);
        APEX_JSON.WRITE('status', 'updated');
        APEX_JSON.CLOSE_OBJECT;
    END IF;
END;
]',
        p_comments       => 'PUT handler - update model task'
    );

    -- DELETE /mcr/v1/models/tasks/:model_task_id
    -- Delete a model task
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_models',
        p_pattern        => 'tasks/:model_task_id',
        p_method         => 'DELETE',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_model_task_id NUMBER;
    l_rows          NUMBER;
BEGIN
    l_model_task_id := TO_NUMBER(:model_task_id);

    DELETE FROM tab_mcr_model_tasks
     WHERE model_task_id = l_model_task_id;

    l_rows := SQL%ROWCOUNT;
    COMMIT;

    IF l_rows = 0 THEN
        OWA_UTIL.STATUS_LINE(404, 'Not Found');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'Model task not found');
        APEX_JSON.CLOSE_OBJECT;
    ELSE
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('model_task_id', l_model_task_id);
        APEX_JSON.WRITE('status', 'deleted');
        APEX_JSON.CLOSE_OBJECT;
    END IF;
END;
]',
        p_comments       => 'DELETE handler - delete model task'
    );

    COMMIT;
END;
/
