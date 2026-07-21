CREATE OR REPLACE PACKAGE BODY pkg_mcr_tasks AS
    /*
    ** PKG_MCR_TASKS (Body)
    ** Task CRUD, dependency validation, task status management, and action
    ** management for MCR Manager.
    **
    ** Requirements 4.3, 4.4, 4.5, 5.3: Task operations with dependency
    ** validation, sequential ordering, and action management.
    */

    ----------------------------------------------------------------------------
    -- Private Types
    ----------------------------------------------------------------------------
    TYPE t_number_tab IS TABLE OF NUMBER INDEX BY PLS_INTEGER;

    ----------------------------------------------------------------------------
    -- parse_csv (private)
    --
    -- Tokenizes a comma-separated string of numbers into a PL/SQL associative
    -- array. Trims whitespace around each token. Skips empty tokens.
    ----------------------------------------------------------------------------
    PROCEDURE parse_csv(
        p_csv    IN  VARCHAR2,
        p_result OUT t_number_tab
    ) IS
        l_str    VARCHAR2(32767) := p_csv;
        l_idx    PLS_INTEGER := 0;
        l_pos    PLS_INTEGER;
        l_token  VARCHAR2(100);
    BEGIN
        IF l_str IS NULL OR TRIM(l_str) IS NULL THEN
            RETURN;
        END IF;

        l_str := l_str || ',';  -- sentinel for parsing

        LOOP
            l_pos := INSTR(l_str, ',');
            EXIT WHEN l_pos = 0;

            l_token := TRIM(SUBSTR(l_str, 1, l_pos - 1));
            l_str   := SUBSTR(l_str, l_pos + 1);

            IF l_token IS NOT NULL THEN
                l_idx := l_idx + 1;
                p_result(l_idx) := TO_NUMBER(l_token);
            END IF;
        END LOOP;
    END parse_csv;

    ----------------------------------------------------------------------------
    -- create_task
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
    ) IS
        l_task_seq  NUMBER;
        l_task_id   NUMBER;
        l_hard_list t_number_tab;
        l_soft_list t_number_tab;
        l_dep_id    NUMBER;
        l_valid     BOOLEAN;
    BEGIN
        -- 1. Determine next sequential task_seq within this MCR
        SELECT NVL(MAX(task_seq), 0) + 1
          INTO l_task_seq
          FROM tab_mcr_tasks
         WHERE mcr_id = p_mcr_id;

        -- 2. Insert the task record
        INSERT INTO tab_mcr_tasks (
            mcr_id,
            task_seq,
            title,
            description,
            jira_reference,
            start_time,
            estimated_duration_mins,
            owner_dept_id,
            implementor_id,
            implementor_type,
            task_status,
            benefits,
            created_by_user_id,
            created_at,
            updated_at
        ) VALUES (
            p_mcr_id,
            l_task_seq,
            p_title,
            p_description,
            p_jira_ref,
            p_start_time,
            p_duration,
            p_owner_dept_id,
            p_implementor_id,
            p_impl_type,
            'Ready',
            p_benefits,
            p_user_id,
            SYSTIMESTAMP,
            SYSTIMESTAMP
        )
        RETURNING task_id INTO l_task_id;

        -- 3. Parse and insert hard dependencies
        parse_csv(p_hard_deps, l_hard_list);

        FOR i IN 1 .. l_hard_list.COUNT LOOP
            l_dep_id := l_hard_list(i);

            -- Check for self-reference
            IF l_dep_id = l_task_id THEN
                RAISE_APPLICATION_ERROR(-20010,
                    'Self-dependency detected: task ' || l_task_id ||
                    ' cannot depend on itself');
            END IF;

            INSERT INTO tab_mcr_dependencies (
                task_id,
                depends_on_task_id,
                dependency_type
            ) VALUES (
                l_task_id,
                l_dep_id,
                'HARD'
            );
        END LOOP;

        -- 4. Parse and insert soft dependencies
        parse_csv(p_soft_deps, l_soft_list);

        FOR i IN 1 .. l_soft_list.COUNT LOOP
            l_dep_id := l_soft_list(i);

            -- Check for self-reference
            IF l_dep_id = l_task_id THEN
                RAISE_APPLICATION_ERROR(-20010,
                    'Self-dependency detected: task ' || l_task_id ||
                    ' cannot depend on itself');
            END IF;

            INSERT INTO tab_mcr_dependencies (
                task_id,
                depends_on_task_id,
                dependency_type
            ) VALUES (
                l_task_id,
                l_dep_id,
                'SOFT'
            );
        END LOOP;

        -- 5. Validate dependencies (detect circular chains)
        l_valid := validate_dependencies(
            p_mcr_id    => p_mcr_id,
            p_task_id   => l_task_id,
            p_hard_deps => p_hard_deps,
            p_soft_deps => p_soft_deps
        );

        -- 6. Record creation in audit log
        pkg_mcr_audit.log_change(
            p_user_id     => p_user_id,
            p_operation   => 'CREATE',
            p_object_type => 'TASK',
            p_object_id   => l_task_id,
            p_old_values  => NULL,
            p_new_values  => '{"task_seq":' || l_task_seq ||
                             ',"mcr_id":' || p_mcr_id ||
                             ',"title":"' || p_title ||
                             '","jira_reference":"' || p_jira_ref ||
                             '","implementor_type":"' || p_impl_type ||
                             '","hard_deps":"' || p_hard_deps ||
                             '","soft_deps":"' || p_soft_deps || '"}'
        );
    END create_task;

    ----------------------------------------------------------------------------
    -- validate_dependencies
    ----------------------------------------------------------------------------
    FUNCTION validate_dependencies(
        p_mcr_id    IN NUMBER,
        p_task_id   IN NUMBER,
        p_hard_deps IN VARCHAR2,
        p_soft_deps IN VARCHAR2
    ) RETURN BOOLEAN IS
        l_hard_list   t_number_tab;
        l_soft_list   t_number_tab;
        l_dep_id      NUMBER;
        l_cycle_count NUMBER;
    BEGIN
        -- Parse dependency lists
        parse_csv(p_hard_deps, l_hard_list);
        parse_csv(p_soft_deps, l_soft_list);

        -- Check self-reference in hard dependencies
        FOR i IN 1 .. l_hard_list.COUNT LOOP
            IF l_hard_list(i) = p_task_id THEN
                RAISE_APPLICATION_ERROR(-20010,
                    'Self-dependency detected: task ' || p_task_id ||
                    ' cannot depend on itself');
            END IF;
        END LOOP;

        -- Check self-reference in soft dependencies
        FOR i IN 1 .. l_soft_list.COUNT LOOP
            IF l_soft_list(i) = p_task_id THEN
                RAISE_APPLICATION_ERROR(-20010,
                    'Self-dependency detected: task ' || p_task_id ||
                    ' cannot depend on itself');
            END IF;
        END LOOP;

        -- Check for circular dependencies in hard deps
        FOR i IN 1 .. l_hard_list.COUNT LOOP
            l_dep_id := l_hard_list(i);

            WITH reachable (ancestor_task_id) AS (
                SELECT depends_on_task_id
                  FROM tab_mcr_dependencies
                 WHERE task_id = l_dep_id
                UNION ALL
                SELECT d.depends_on_task_id
                  FROM tab_mcr_dependencies d
                  JOIN reachable r ON d.task_id = r.ancestor_task_id
            )
            SELECT COUNT(*)
              INTO l_cycle_count
              FROM reachable
             WHERE ancestor_task_id = p_task_id;

            IF l_cycle_count > 0 THEN
                RAISE_APPLICATION_ERROR(-20011,
                    'Circular dependency detected: task ' || p_task_id ||
                    ' -> task ' || l_dep_id ||
                    ' creates a cycle in the dependency graph');
            END IF;
        END LOOP;

        -- Check for circular dependencies in soft deps
        FOR i IN 1 .. l_soft_list.COUNT LOOP
            l_dep_id := l_soft_list(i);

            WITH reachable (ancestor_task_id) AS (
                SELECT depends_on_task_id
                  FROM tab_mcr_dependencies
                 WHERE task_id = l_dep_id
                UNION ALL
                SELECT d.depends_on_task_id
                  FROM tab_mcr_dependencies d
                  JOIN reachable r ON d.task_id = r.ancestor_task_id
            )
            SELECT COUNT(*)
              INTO l_cycle_count
              FROM reachable
             WHERE ancestor_task_id = p_task_id;

            IF l_cycle_count > 0 THEN
                RAISE_APPLICATION_ERROR(-20011,
                    'Circular dependency detected: task ' || p_task_id ||
                    ' -> task ' || l_dep_id ||
                    ' creates a cycle in the dependency graph');
            END IF;
        END LOOP;

        RETURN TRUE;
    END validate_dependencies;

    ----------------------------------------------------------------------------
    -- update_task
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
    ) IS
        l_mcr_id         NUMBER;
        l_mcr_status     VARCHAR2(30);
        l_old_title      VARCHAR2(4000);
        l_old_desc       VARCHAR2(4000);
        l_old_jira       VARCHAR2(4000);
        l_old_start      TIMESTAMP WITH TIME ZONE;
        l_old_duration   NUMBER;
        l_old_owner_dept NUMBER;
        l_old_impl_id    NUMBER;
        l_old_impl_type  VARCHAR2(30);
        l_old_benefits   VARCHAR2(4000);
        l_old_values     CLOB;
        l_new_values     CLOB;
        l_hard_list      t_number_tab;
        l_soft_list      t_number_tab;
        l_valid          BOOLEAN;
    BEGIN
        -- 1. Fetch existing task and MCR status
        BEGIN
            SELECT t.mcr_id,
                   t.title,
                   t.description,
                   t.jira_reference,
                   t.start_time,
                   t.estimated_duration_mins,
                   t.owner_dept_id,
                   t.implementor_id,
                   t.implementor_type,
                   t.benefits,
                   r.mcr_status
              INTO l_mcr_id,
                   l_old_title,
                   l_old_desc,
                   l_old_jira,
                   l_old_start,
                   l_old_duration,
                   l_old_owner_dept,
                   l_old_impl_id,
                   l_old_impl_type,
                   l_old_benefits,
                   l_mcr_status
              FROM tab_mcr_tasks t
              JOIN tab_mcr_requests r ON r.mcr_id = t.mcr_id
             WHERE t.task_id = p_task_id;
        EXCEPTION
            WHEN NO_DATA_FOUND THEN
                RAISE_APPLICATION_ERROR(-20012,
                    'Task not found: task_id ' || p_task_id);
        END;

        -- 2. Check MCR is in editable state
        IF l_mcr_status NOT IN ('Draft', 'Review', 'Pending', 'Partial', 'Approved') THEN
            RAISE_APPLICATION_ERROR(-20003,
                'MCR is in state ' || l_mcr_status ||
                ' and cannot be modified');
        END IF;

        -- 3. Build JSON of old values for audit
        l_old_values := '{"title":"' || l_old_title ||
                        '","description":"' || l_old_desc ||
                        '","jira_reference":"' || l_old_jira ||
                        '","estimated_duration_mins":' || NVL(TO_CHAR(l_old_duration), 'null') ||
                        ',"owner_dept_id":' || NVL(TO_CHAR(l_old_owner_dept), 'null') ||
                        ',"implementor_id":' || NVL(TO_CHAR(l_old_impl_id), 'null') ||
                        ',"implementor_type":"' || l_old_impl_type ||
                        '","benefits":"' || l_old_benefits || '"}';

        -- 4. Clear old dependencies and re-insert from new params
        DELETE FROM tab_mcr_dependencies
         WHERE task_id = p_task_id;

        parse_csv(p_hard_deps, l_hard_list);
        FOR i IN 1 .. l_hard_list.COUNT LOOP
            IF l_hard_list(i) = p_task_id THEN
                RAISE_APPLICATION_ERROR(-20010,
                    'Self-dependency detected: task ' || p_task_id ||
                    ' cannot depend on itself');
            END IF;

            INSERT INTO tab_mcr_dependencies (
                task_id, depends_on_task_id, dependency_type
            ) VALUES (
                p_task_id, l_hard_list(i), 'HARD'
            );
        END LOOP;

        parse_csv(p_soft_deps, l_soft_list);
        FOR i IN 1 .. l_soft_list.COUNT LOOP
            IF l_soft_list(i) = p_task_id THEN
                RAISE_APPLICATION_ERROR(-20010,
                    'Self-dependency detected: task ' || p_task_id ||
                    ' cannot depend on itself');
            END IF;

            INSERT INTO tab_mcr_dependencies (
                task_id, depends_on_task_id, dependency_type
            ) VALUES (
                p_task_id, l_soft_list(i), 'SOFT'
            );
        END LOOP;

        -- 5. Validate dependencies (detect cycles)
        l_valid := validate_dependencies(
            p_mcr_id    => l_mcr_id,
            p_task_id   => p_task_id,
            p_hard_deps => p_hard_deps,
            p_soft_deps => p_soft_deps
        );

        -- 6. Update the task record
        UPDATE tab_mcr_tasks
           SET title                  = p_title,
               description            = p_description,
               jira_reference         = p_jira_ref,
               start_time             = p_start_time,
               estimated_duration_mins = p_duration,
               owner_dept_id          = p_owner_dept_id,
               implementor_id         = p_implementor_id,
               implementor_type       = p_impl_type,
               benefits               = p_benefits,
               updated_at             = SYSTIMESTAMP
         WHERE task_id = p_task_id;

        -- 7. If MCR was Approved, trigger handle_task_modification
        IF l_mcr_status = 'Approved' THEN
            pkg_mcr_lifecycle.handle_task_modification(l_mcr_id);
        END IF;

        -- 8. Build new values JSON and record audit
        l_new_values := '{"title":"' || p_title ||
                        '","description":"' || p_description ||
                        '","jira_reference":"' || p_jira_ref ||
                        '","estimated_duration_mins":' || NVL(TO_CHAR(p_duration), 'null') ||
                        ',"owner_dept_id":' || NVL(TO_CHAR(p_owner_dept_id), 'null') ||
                        ',"implementor_id":' || NVL(TO_CHAR(p_implementor_id), 'null') ||
                        ',"implementor_type":"' || p_impl_type ||
                        '","benefits":"' || p_benefits ||
                        '","hard_deps":"' || p_hard_deps ||
                        '","soft_deps":"' || p_soft_deps || '"}';

        pkg_mcr_audit.log_change(
            p_user_id     => p_user_id,
            p_operation   => 'UPDATE',
            p_object_type => 'TASK',
            p_object_id   => p_task_id,
            p_old_values  => l_old_values,
            p_new_values  => l_new_values
        );
    END update_task;

    ----------------------------------------------------------------------------
    -- delete_task
    ----------------------------------------------------------------------------
    PROCEDURE delete_task(
        p_user_id IN NUMBER,
        p_task_id IN NUMBER
    ) IS
        l_mcr_id     NUMBER;
        l_mcr_status VARCHAR2(30);
        l_title      VARCHAR2(4000);
        l_task_seq   NUMBER;
    BEGIN
        -- 1. Fetch task's mcr_id and MCR status
        BEGIN
            SELECT t.mcr_id, t.title, t.task_seq, r.mcr_status
              INTO l_mcr_id, l_title, l_task_seq, l_mcr_status
              FROM tab_mcr_tasks t
              JOIN tab_mcr_requests r ON r.mcr_id = t.mcr_id
             WHERE t.task_id = p_task_id;
        EXCEPTION
            WHEN NO_DATA_FOUND THEN
                RAISE_APPLICATION_ERROR(-20012,
                    'Task not found: task_id ' || p_task_id);
        END;

        -- 2. Only allow deletion if MCR is in Draft or Review
        IF l_mcr_status NOT IN ('Draft', 'Review') THEN
            RAISE_APPLICATION_ERROR(-20003,
                'Cannot delete task: MCR is in state ' || l_mcr_status ||
                '. Deletion only allowed in Draft or Review');
        END IF;

        -- 3. Remove dependencies referencing this task
        DELETE FROM tab_mcr_dependencies
         WHERE task_id = p_task_id
            OR depends_on_task_id = p_task_id;

        -- 4. Remove document links for this task
        DELETE FROM tab_mcr_doc_links
         WHERE task_id = p_task_id;

        -- 5. Remove actions for this task
        DELETE FROM tab_mcr_actions
         WHERE task_id = p_task_id;

        -- 6. Remove the task itself
        DELETE FROM tab_mcr_tasks
         WHERE task_id = p_task_id;

        -- 7. Record deletion in audit log
        pkg_mcr_audit.log_change(
            p_user_id     => p_user_id,
            p_operation   => 'DELETE',
            p_object_type => 'TASK',
            p_object_id   => p_task_id,
            p_old_values  => '{"task_seq":' || l_task_seq ||
                             ',"mcr_id":' || l_mcr_id ||
                             ',"title":"' || l_title || '"}',
            p_new_values  => NULL
        );
    END delete_task;

    ----------------------------------------------------------------------------
    -- get_tasks
    ----------------------------------------------------------------------------
    PROCEDURE get_tasks(
        p_mcr_id IN NUMBER
    ) IS
    BEGIN
        APEX_JSON.open_array;

        FOR rec IN (
            SELECT task_id,
                   task_seq,
                   title,
                   description,
                   jira_reference,
                   start_time,
                   estimated_duration_mins,
                   owner_dept_id,
                   implementor_id,
                   implementor_type,
                   task_status,
                   benefits,
                   created_by_user_id,
                   created_at,
                   updated_at
              FROM tab_mcr_tasks
             WHERE mcr_id = p_mcr_id
             ORDER BY task_seq
        ) LOOP
            APEX_JSON.open_object;
            APEX_JSON.write('task_id',                rec.task_id);
            APEX_JSON.write('task_seq',               rec.task_seq);
            APEX_JSON.write('title',                  rec.title);
            APEX_JSON.write('description',            rec.description);
            APEX_JSON.write('jira_reference',         rec.jira_reference);
            APEX_JSON.write('start_time',             TO_CHAR(rec.start_time, 'YYYY-MM-DD"T"HH24:MI:SS.FFTZH:TZM'));
            APEX_JSON.write('estimated_duration_mins', rec.estimated_duration_mins);
            APEX_JSON.write('owner_dept_id',          rec.owner_dept_id);
            APEX_JSON.write('implementor_id',         rec.implementor_id);
            APEX_JSON.write('implementor_type',       rec.implementor_type);
            APEX_JSON.write('task_status',            rec.task_status);
            APEX_JSON.write('benefits',               rec.benefits);
            APEX_JSON.write('created_by_user_id',     rec.created_by_user_id);
            APEX_JSON.write('created_at',             TO_CHAR(rec.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.FFTZH:TZM'));
            APEX_JSON.write('updated_at',             TO_CHAR(rec.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.FFTZH:TZM'));

            -- Hard dependencies sub-array
            APEX_JSON.open_array('hard_deps');
            FOR dep IN (
                SELECT depends_on_task_id
                  FROM tab_mcr_dependencies
                 WHERE task_id = rec.task_id
                   AND dependency_type = 'HARD'
                 ORDER BY depends_on_task_id
            ) LOOP
                APEX_JSON.write(dep.depends_on_task_id);
            END LOOP;
            APEX_JSON.close_array;

            -- Soft dependencies sub-array
            APEX_JSON.open_array('soft_deps');
            FOR dep IN (
                SELECT depends_on_task_id
                  FROM tab_mcr_dependencies
                 WHERE task_id = rec.task_id
                   AND dependency_type = 'SOFT'
                 ORDER BY depends_on_task_id
            ) LOOP
                APEX_JSON.write(dep.depends_on_task_id);
            END LOOP;
            APEX_JSON.close_array;

            APEX_JSON.close_object;
        END LOOP;

        APEX_JSON.close_array;
    END get_tasks;

    ----------------------------------------------------------------------------
    -- change_task_status
    ----------------------------------------------------------------------------
    PROCEDURE change_task_status(
        p_user_id    IN NUMBER,
        p_task_id    IN NUMBER,
        p_new_status IN VARCHAR2
    ) IS
        l_mcr_id          NUMBER;
        l_owner_dept_id   NUMBER;
        l_created_by      NUMBER;
        l_old_status      VARCHAR2(30);
        l_user_dept_id    NUMBER;
        l_has_perm        BOOLEAN := FALSE;
    BEGIN
        -- 1. Fetch task details
        BEGIN
            SELECT mcr_id, owner_dept_id, created_by_user_id, task_status
              INTO l_mcr_id, l_owner_dept_id, l_created_by, l_old_status
              FROM tab_mcr_tasks
             WHERE task_id = p_task_id;
        EXCEPTION
            WHEN NO_DATA_FOUND THEN
                RAISE_APPLICATION_ERROR(-20012,
                    'Task not found: task_id ' || p_task_id);
        END;

        -- 2. Check permission: Management Group, Owning Team, or Author
        -- Check Management Group (Responsible or Accountable in RACI)
        IF pkg_mcr_core.is_management_group(p_user_id, l_mcr_id) THEN
            l_has_perm := TRUE;
        END IF;

        -- Check if user is the task author
        IF NOT l_has_perm AND p_user_id = l_created_by THEN
            l_has_perm := TRUE;
        END IF;

        -- Check if user is in the owning team (same department)
        IF NOT l_has_perm AND l_owner_dept_id IS NOT NULL THEN
            BEGIN
                SELECT department_id
                  INTO l_user_dept_id
                  FROM tab_idcs_users
                 WHERE user_id = p_user_id;

                IF l_user_dept_id = l_owner_dept_id THEN
                    l_has_perm := TRUE;
                END IF;
            EXCEPTION
                WHEN NO_DATA_FOUND THEN
                    NULL; -- User not found in users table, no permission
            END;
        END IF;

        -- 3. If no permission, raise error
        IF NOT l_has_perm THEN
            RAISE_APPLICATION_ERROR(-20013,
                'Insufficient permission to change task status. ' ||
                'User must be in Management Group, Owning Team, or be the task Author');
        END IF;

        -- 4. Update task status
        UPDATE tab_mcr_tasks
           SET task_status = p_new_status,
               updated_at  = SYSTIMESTAMP
         WHERE task_id = p_task_id;

        -- 5. Record in audit log
        pkg_mcr_audit.log_change(
            p_user_id     => p_user_id,
            p_operation   => 'UPDATE',
            p_object_type => 'TASK',
            p_object_id   => p_task_id,
            p_old_values  => '{"task_status":"' || l_old_status || '"}',
            p_new_values  => '{"task_status":"' || p_new_status || '"}'
        );
    END change_task_status;

    ----------------------------------------------------------------------------
    -- get_dependency_map
    ----------------------------------------------------------------------------
    PROCEDURE get_dependency_map(
        p_mcr_id IN NUMBER
    ) IS
        l_mcr_number VARCHAR2(100);
        l_mcr_status VARCHAR2(30);
    BEGIN
        -- Fetch MCR details for the root node
        SELECT mcr_number, mcr_status
          INTO l_mcr_number, l_mcr_status
          FROM tab_mcr_requests
         WHERE mcr_id = p_mcr_id;

        APEX_JSON.open_object;

        -- Nodes array: MCR root node + one node per task
        APEX_JSON.open_array('nodes');

        -- MCR root node
        APEX_JSON.open_object;
        APEX_JSON.write('id',     'mcr_' || p_mcr_id);
        APEX_JSON.write('title',  l_mcr_number);
        APEX_JSON.write('status', l_mcr_status);
        APEX_JSON.write('type',   'MCR');
        APEX_JSON.close_object;

        -- Task nodes
        FOR rec IN (
            SELECT task_id, title, task_status
              FROM tab_mcr_tasks
             WHERE mcr_id = p_mcr_id
             ORDER BY task_seq
        ) LOOP
            APEX_JSON.open_object;
            APEX_JSON.write('id',     'task_' || rec.task_id);
            APEX_JSON.write('title',  rec.title);
            APEX_JSON.write('status', rec.task_status);
            APEX_JSON.write('type',   'TASK');
            APEX_JSON.close_object;
        END LOOP;

        APEX_JSON.close_array;

        -- Edges array: each dependency as source→target with type
        APEX_JSON.open_array('edges');

        FOR rec IN (
            SELECT d.depends_on_task_id AS source_task_id,
                   d.task_id            AS target_task_id,
                   d.dependency_type
              FROM tab_mcr_dependencies d
              JOIN tab_mcr_tasks t ON t.task_id = d.task_id
             WHERE t.mcr_id = p_mcr_id
             ORDER BY d.depends_on_task_id, d.task_id
        ) LOOP
            APEX_JSON.open_object;
            APEX_JSON.write('source', 'task_' || rec.source_task_id);
            APEX_JSON.write('target', 'task_' || rec.target_task_id);
            APEX_JSON.write('type',   rec.dependency_type);
            APEX_JSON.close_object;
        END LOOP;

        APEX_JSON.close_array;

        APEX_JSON.close_object;
    END get_dependency_map;

    ----------------------------------------------------------------------------
    -- get_actions
    ----------------------------------------------------------------------------
    PROCEDURE get_actions(
        p_task_id IN NUMBER
    ) IS
    BEGIN
        APEX_JSON.open_array;

        FOR rec IN (
            SELECT action_id,
                   ordinal_position,
                   title,
                   description,
                   action_status,
                   updated_at
              FROM tab_mcr_actions
             WHERE task_id = p_task_id
             ORDER BY ordinal_position
        ) LOOP
            APEX_JSON.open_object;
            APEX_JSON.write('action_id',        rec.action_id);
            APEX_JSON.write('ordinal_position',  rec.ordinal_position);
            APEX_JSON.write('title',            rec.title);
            APEX_JSON.write('description',      rec.description);
            APEX_JSON.write('action_status',    rec.action_status);
            APEX_JSON.write('updated_at',       TO_CHAR(rec.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'));
            APEX_JSON.close_object;
        END LOOP;

        APEX_JSON.close_array;
    END get_actions;

    ----------------------------------------------------------------------------
    -- create_action
    ----------------------------------------------------------------------------
    PROCEDURE create_action(
        p_user_id     IN NUMBER,
        p_task_id     IN NUMBER,
        p_title       IN VARCHAR2,
        p_description IN VARCHAR2
    ) IS
        l_ordinal   NUMBER;
        l_action_id NUMBER;
    BEGIN
        -- 1. Determine next ordinal position
        SELECT NVL(MAX(ordinal_position), 0) + 1
          INTO l_ordinal
          FROM tab_mcr_actions
         WHERE task_id = p_task_id;

        -- 2. Insert the action record
        INSERT INTO tab_mcr_actions (
            task_id,
            ordinal_position,
            title,
            description,
            action_status,
            updated_at
        ) VALUES (
            p_task_id,
            l_ordinal,
            p_title,
            p_description,
            'Not_Started',
            SYSTIMESTAMP
        )
        RETURNING action_id INTO l_action_id;

        -- 3. Record creation in audit log
        pkg_mcr_audit.log_change(
            p_user_id     => p_user_id,
            p_operation   => 'CREATE',
            p_object_type => 'ACTION',
            p_object_id   => l_action_id,
            p_old_values  => NULL,
            p_new_values  => '{"task_id":' || p_task_id ||
                             ',"ordinal_position":' || l_ordinal ||
                             ',"title":"' || p_title ||
                             '","description":"' || p_description ||
                             '","action_status":"Not_Started"}'
        );
    END create_action;

    ----------------------------------------------------------------------------
    -- update_action
    ----------------------------------------------------------------------------
    PROCEDURE update_action(
        p_user_id     IN NUMBER,
        p_action_id   IN NUMBER,
        p_title       IN VARCHAR2,
        p_description IN VARCHAR2
    ) IS
        l_old_title       tab_mcr_actions.title%TYPE;
        l_old_description tab_mcr_actions.description%TYPE;
    BEGIN
        -- 1. Build old values from current record
        SELECT title, description
          INTO l_old_title, l_old_description
          FROM tab_mcr_actions
         WHERE action_id = p_action_id;

        -- 2. Update the action record
        UPDATE tab_mcr_actions
           SET title       = p_title,
               description = p_description,
               updated_at  = SYSTIMESTAMP
         WHERE action_id = p_action_id;

        -- 3. Record update in audit log
        pkg_mcr_audit.log_change(
            p_user_id     => p_user_id,
            p_operation   => 'UPDATE',
            p_object_type => 'ACTION',
            p_object_id   => p_action_id,
            p_old_values  => '{"title":"' || l_old_title ||
                             '","description":"' || l_old_description || '"}',
            p_new_values  => '{"title":"' || p_title ||
                             '","description":"' || p_description || '"}'
        );
    END update_action;

    ----------------------------------------------------------------------------
    -- delete_action
    ----------------------------------------------------------------------------
    PROCEDURE delete_action(
        p_user_id   IN NUMBER,
        p_action_id IN NUMBER
    ) IS
        l_task_id         tab_mcr_actions.task_id%TYPE;
        l_deleted_ordinal tab_mcr_actions.ordinal_position%TYPE;
        l_old_title       tab_mcr_actions.title%TYPE;
        l_old_description tab_mcr_actions.description%TYPE;
    BEGIN
        -- 1. Fetch ordinal_position and task_id of the action being deleted
        SELECT task_id, ordinal_position, title, description
          INTO l_task_id, l_deleted_ordinal, l_old_title, l_old_description
          FROM tab_mcr_actions
         WHERE action_id = p_action_id;

        -- 2. Delete the action
        DELETE FROM tab_mcr_actions
         WHERE action_id = p_action_id;

        -- 3. Reorder remaining actions (decrement ordinal_position for actions after deleted)
        UPDATE tab_mcr_actions
           SET ordinal_position = ordinal_position - 1
         WHERE task_id = l_task_id
           AND ordinal_position > l_deleted_ordinal;

        -- 4. Record deletion in audit log
        pkg_mcr_audit.log_change(
            p_user_id     => p_user_id,
            p_operation   => 'DELETE',
            p_object_type => 'ACTION',
            p_object_id   => p_action_id,
            p_old_values  => '{"task_id":' || l_task_id ||
                             ',"ordinal_position":' || l_deleted_ordinal ||
                             ',"title":"' || l_old_title ||
                             '","description":"' || l_old_description || '"}',
            p_new_values  => NULL
        );
    END delete_action;

    ----------------------------------------------------------------------------
    -- update_action_statuses
    ----------------------------------------------------------------------------
    PROCEDURE update_action_statuses(
        p_user_id       IN NUMBER,
        p_task_id       IN NUMBER,
        p_statuses_json IN CLOB,
        p_comment       IN VARCHAR2
    ) IS
        l_mcr_id        tab_mcr_tasks.mcr_id%TYPE;
        l_owner_dept_id tab_mcr_tasks.owner_dept_id%TYPE;
        l_user_dept_id  NUMBER;
        l_action_id     NUMBER;
        l_status        VARCHAR2(20);
        l_old_status    VARCHAR2(20);
        l_count         NUMBER;
    BEGIN
        -- 1. Fetch task's mcr_id and owner_dept_id
        SELECT mcr_id, owner_dept_id
          INTO l_mcr_id, l_owner_dept_id
          FROM tab_mcr_tasks
         WHERE task_id = p_task_id;

        -- 2. Check permission: Management Group or Owning Team
        --    Get user's department
        SELECT department_id
          INTO l_user_dept_id
          FROM tab_idcs_users
         WHERE user_id = p_user_id;

        IF NOT pkg_mcr_core.is_management_group(p_user_id, l_mcr_id)
           AND (l_user_dept_id IS NULL OR l_user_dept_id != l_owner_dept_id) THEN
            RAISE_APPLICATION_ERROR(-20013,
                'Insufficient permission: user must be in Management Group or Owning Team');
        END IF;

        -- 3. Parse p_statuses_json — array of {action_id, status}
        APEX_JSON.parse(p_statuses_json);
        l_count := APEX_JSON.get_count(p_path => '.');

        -- 4. For each entry, update action status and audit
        FOR i IN 1 .. l_count LOOP
            l_action_id := APEX_JSON.get_number(p_path => '[%d].action_id', p0 => i);
            l_status    := APEX_JSON.get_varchar2(p_path => '[%d].status', p0 => i);

            -- Get old status for audit
            SELECT action_status
              INTO l_old_status
              FROM tab_mcr_actions
             WHERE action_id = l_action_id;

            -- Update the action status
            UPDATE tab_mcr_actions
               SET action_status = l_status,
                   updated_at    = SYSTIMESTAMP
             WHERE action_id = l_action_id;

            -- Audit log for each change, include comment in new_values if provided
            pkg_mcr_audit.log_change(
                p_user_id     => p_user_id,
                p_operation   => 'UPDATE',
                p_object_type => 'ACTION',
                p_object_id   => l_action_id,
                p_old_values  => '{"action_status":"' || l_old_status || '"}',
                p_new_values  => '{"action_status":"' || l_status || '"' ||
                                 CASE WHEN p_comment IS NOT NULL
                                      THEN ',"comment":"' || p_comment || '"'
                                      ELSE ''
                                 END || '}'
            );
        END LOOP;
    END update_action_statuses;

END pkg_mcr_tasks;
/
