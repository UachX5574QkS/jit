CREATE OR REPLACE PACKAGE BODY pkg_mcr_lifecycle AS
    /*
    ** PKG_MCR_LIFECYCLE (Body)
    ** Handles MCR status transitions, approval logic, lock enforcement, and
    ** scheduled lifecycle automation.
    */

    ----------------------------------------------------------------------------
    -- approve_mcr
    ----------------------------------------------------------------------------
    PROCEDURE approve_mcr(
        p_user_id IN NUMBER,
        p_mcr_id  IN NUMBER
    ) IS
        l_status   tab_mcr_requests.mcr_status%TYPE;
    BEGIN
        -- 1. Check MCR status is 'Pending'
        SELECT mcr_status
          INTO l_status
          FROM tab_mcr_requests
         WHERE mcr_id = p_mcr_id;

        IF l_status != 'Pending' THEN
            RAISE_APPLICATION_ERROR(-20030,
                'MCR must be in Pending status to approve. Current status: ' || l_status);
        END IF;

        -- 2. Check user is in Management Group
        IF NOT pkg_mcr_core.is_management_group(p_user_id, p_mcr_id) THEN
            RAISE_APPLICATION_ERROR(-20033,
                'User ' || p_user_id || ' is not in the Management Group for MCR ' || p_mcr_id);
        END IF;

        -- 3. Check approval prerequisites (raises e_prerequisites_failed if not met)
        check_approval_prerequisites(p_mcr_id);

        -- 4. Transition to Approved
        UPDATE tab_mcr_requests
           SET mcr_status          = 'Approved',
               approved_by_user_id = p_user_id,
               approved_at         = SYSTIMESTAMP,
               updated_at          = SYSTIMESTAMP
         WHERE mcr_id = p_mcr_id;

        -- 5. Record audit log
        pkg_mcr_audit.log_change(
            p_user_id     => p_user_id,
            p_operation   => 'UPDATE',
            p_object_type => 'MCR',
            p_object_id   => p_mcr_id,
            p_old_values  => '{"mcr_status":"' || l_status || '","approved_by_user_id":null,"approved_at":null}',
            p_new_values  => '{"mcr_status":"Approved","approved_by_user_id":' || p_user_id || ',"approved_at":"' || TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') || '"}'
        );
    END approve_mcr;

    ----------------------------------------------------------------------------
    -- lock_mcr
    ----------------------------------------------------------------------------
    PROCEDURE lock_mcr(
        p_user_id IN NUMBER,
        p_mcr_id  IN NUMBER
    ) IS
        l_status   tab_mcr_requests.mcr_status%TYPE;
    BEGIN
        -- 1. Check MCR status is 'Approved'
        SELECT mcr_status
          INTO l_status
          FROM tab_mcr_requests
         WHERE mcr_id = p_mcr_id;

        IF l_status != 'Approved' THEN
            RAISE_APPLICATION_ERROR(-20031,
                'MCR must be in Approved status to lock. Current status: ' || l_status);
        END IF;

        -- 2. Transition to Locked
        UPDATE tab_mcr_requests
           SET mcr_status = 'Locked',
               updated_at = SYSTIMESTAMP
         WHERE mcr_id = p_mcr_id;

        -- 3. Record audit log
        pkg_mcr_audit.log_change(
            p_user_id     => p_user_id,
            p_operation   => 'UPDATE',
            p_object_type => 'MCR',
            p_object_id   => p_mcr_id,
            p_old_values  => '{"mcr_status":"Approved"}',
            p_new_values  => '{"mcr_status":"Locked"}'
        );
    END lock_mcr;

    ----------------------------------------------------------------------------
    -- handle_task_modification
    ----------------------------------------------------------------------------
    PROCEDURE handle_task_modification(
        p_mcr_id IN NUMBER
    ) IS
        l_status            tab_mcr_requests.mcr_status%TYPE;
        l_approved_by       tab_mcr_requests.approved_by_user_id%TYPE;
        l_approved_at_str   VARCHAR2(100);
    BEGIN
        -- 1. Get current MCR status
        SELECT mcr_status, approved_by_user_id,
               TO_CHAR(approved_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM')
          INTO l_status, l_approved_by, l_approved_at_str
          FROM tab_mcr_requests
         WHERE mcr_id = p_mcr_id;

        -- 2. Only act if MCR is Approved
        IF l_status = 'Approved' THEN
            UPDATE tab_mcr_requests
               SET mcr_status          = 'Partial',
                   approved_by_user_id = NULL,
                   approved_at         = NULL,
                   updated_at          = SYSTIMESTAMP
             WHERE mcr_id = p_mcr_id;

            -- Record audit log (use approved_by as the context user for the system action)
            pkg_mcr_audit.log_change(
                p_user_id     => l_approved_by,
                p_operation   => 'UPDATE',
                p_object_type => 'MCR',
                p_object_id   => p_mcr_id,
                p_old_values  => '{"mcr_status":"Approved","approved_by_user_id":' || l_approved_by || ',"approved_at":"' || l_approved_at_str || '"}',
                p_new_values  => '{"mcr_status":"Partial","approved_by_user_id":null,"approved_at":null}'
            );
        END IF;
    END handle_task_modification;

    ----------------------------------------------------------------------------
    -- get_partial_changes
    ----------------------------------------------------------------------------
    PROCEDURE get_partial_changes(
        p_mcr_id IN NUMBER
    ) IS
        l_approved_at  tab_mcr_requests.approved_at%TYPE;
    BEGIN
        -- 1. Get the last approved_at timestamp.
        --    If approved_at is NULL (cleared after revert to Partial), look up
        --    the most recent approval audit entry for this MCR.
        SELECT approved_at
          INTO l_approved_at
          FROM tab_mcr_requests
         WHERE mcr_id = p_mcr_id;

        IF l_approved_at IS NULL THEN
            -- Fall back to the latest audit entry that recorded an approval
            SELECT MAX(event_time)
              INTO l_approved_at
              FROM tab_mcr_audit_log
             WHERE object_type = 'MCR'
               AND object_id  = p_mcr_id
               AND operation  = 'UPDATE'
               AND new_values LIKE '%"mcr_status":"Approved"%';
        END IF;

        -- 2. Query tasks modified since last approval and output as JSON
        APEX_JSON.open_object;
        APEX_JSON.write('mcr_id', p_mcr_id);
        APEX_JSON.write('approved_at', TO_CHAR(l_approved_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'));
        APEX_JSON.open_array('changed_tasks');

        FOR rec IN (
            SELECT task_id, task_seq, title, jira_reference,
                   TO_CHAR(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM') AS updated_at
              FROM tab_mcr_tasks
             WHERE mcr_id = p_mcr_id
               AND updated_at > l_approved_at
             ORDER BY task_seq
        ) LOOP
            APEX_JSON.open_object;
            APEX_JSON.write('task_id', rec.task_id);
            APEX_JSON.write('task_seq', rec.task_seq);
            APEX_JSON.write('title', rec.title);
            APEX_JSON.write('jira_reference', rec.jira_reference);
            APEX_JSON.write('updated_at', rec.updated_at);
            APEX_JSON.close_object;
        END LOOP;

        APEX_JSON.close_array;
        APEX_JSON.close_object;
    END get_partial_changes;

    ----------------------------------------------------------------------------
    -- check_approval_prerequisites
    ----------------------------------------------------------------------------
    PROCEDURE check_approval_prerequisites(
        p_mcr_id IN NUMBER
    ) IS
        l_missing_jira    VARCHAR2(4000);
        l_missing_docs    VARCHAR2(4000);
        l_error_msg       VARCHAR2(4000);
    BEGIN
        -- 1. Check all tasks have a non-null jira_reference
        SELECT LISTAGG(task_id, ', ') WITHIN GROUP (ORDER BY task_seq)
          INTO l_missing_jira
          FROM tab_mcr_tasks
         WHERE mcr_id = p_mcr_id
           AND (jira_reference IS NULL OR TRIM(jira_reference) IS NULL);

        -- 2. Check all tasks have at least one entry in tab_mcr_doc_links
        SELECT LISTAGG(t.task_id, ', ') WITHIN GROUP (ORDER BY t.task_seq)
          INTO l_missing_docs
          FROM tab_mcr_tasks t
         WHERE t.mcr_id = p_mcr_id
           AND NOT EXISTS (
               SELECT 1
                 FROM tab_mcr_doc_links dl
                WHERE dl.task_id = t.task_id
           );

        -- 3. If any failures, build error message and raise
        IF l_missing_jira IS NOT NULL OR l_missing_docs IS NOT NULL THEN
            l_error_msg := 'Approval prerequisites not met.';

            IF l_missing_jira IS NOT NULL THEN
                l_error_msg := l_error_msg || ' Tasks missing Jira reference: ' || l_missing_jira || '.';
            END IF;

            IF l_missing_docs IS NOT NULL THEN
                l_error_msg := l_error_msg || ' Tasks missing document links: ' || l_missing_docs || '.';
            END IF;

            RAISE_APPLICATION_ERROR(-20032, l_error_msg);
        END IF;
    END check_approval_prerequisites;

    ----------------------------------------------------------------------------
    -- run_scheduled_transitions
    --
    -- Scheduled job entry point that evaluates all MCRs eligible for
    -- automatic status transitions:
    --   Locked -> Active        (current date within start/end window)
    --   Active -> Complete      (all tasks Complete)
    --   Active -> Partial_Complete (all tasks terminal, not all Complete)
    --   Active -> DNF           (end date passed, tasks not all terminal)
    --
    -- Requirements 10.1, 10.2, 10.3, 10.4, 13.1
    ----------------------------------------------------------------------------
    PROCEDURE run_scheduled_transitions IS
        c_system_user_id  CONSTANT NUMBER := 0;  -- automated transitions user
        l_total_count     NUMBER;
        l_terminal_count  NUMBER;
        l_complete_count  NUMBER;
        l_new_status      tab_mcr_requests.mcr_status%TYPE;
    BEGIN
        -----------------------------------------------------------------------
        -- 1. Locked -> Active
        --    Transition when current date is within the MCR execution window
        -----------------------------------------------------------------------
        FOR rec IN (
            SELECT mcr_id
              FROM tab_mcr_requests
             WHERE mcr_status = 'Locked'
               AND TRUNC(SYSDATE) >= estimated_start_date
               AND TRUNC(SYSDATE) <= estimated_end_date
        ) LOOP
            UPDATE tab_mcr_requests
               SET mcr_status = 'Active',
                   updated_at = SYSTIMESTAMP
             WHERE mcr_id = rec.mcr_id;

            pkg_mcr_audit.log_change(
                p_user_id     => c_system_user_id,
                p_operation   => 'UPDATE',
                p_object_type => 'MCR',
                p_object_id   => rec.mcr_id,
                p_old_values  => '{"mcr_status":"Locked"}',
                p_new_values  => '{"mcr_status":"Active"}'
            );
        END LOOP;

        -----------------------------------------------------------------------
        -- 2. Active -> Complete / Partial_Complete / DNF
        -----------------------------------------------------------------------
        FOR rec IN (
            SELECT mcr_id, estimated_end_date
              FROM tab_mcr_requests
             WHERE mcr_status = 'Active'
        ) LOOP
            -- Count task totals for this MCR
            SELECT COUNT(*)
              INTO l_total_count
              FROM tab_mcr_tasks
             WHERE mcr_id = rec.mcr_id;

            SELECT COUNT(*)
              INTO l_terminal_count
              FROM tab_mcr_tasks
             WHERE mcr_id = rec.mcr_id
               AND task_status IN ('Complete', 'Failed', 'Cancelled');

            SELECT COUNT(*)
              INTO l_complete_count
              FROM tab_mcr_tasks
             WHERE mcr_id = rec.mcr_id
               AND task_status = 'Complete';

            -- Determine new status
            l_new_status := NULL;

            IF l_total_count > 0 AND l_total_count = l_complete_count THEN
                -- All tasks are Complete
                l_new_status := 'Complete';

            ELSIF l_total_count > 0
                  AND l_total_count = l_terminal_count
                  AND l_complete_count < l_total_count THEN
                -- All tasks terminal but not all Complete
                l_new_status := 'Partial_Complete';

            ELSIF TRUNC(SYSDATE) > rec.estimated_end_date
                  AND l_terminal_count < l_total_count THEN
                -- End date passed and not all tasks are terminal
                l_new_status := 'DNF';
            END IF;

            -- Apply transition if a new status was determined
            IF l_new_status IS NOT NULL THEN
                UPDATE tab_mcr_requests
                   SET mcr_status = l_new_status,
                       updated_at = SYSTIMESTAMP
                 WHERE mcr_id = rec.mcr_id;

                pkg_mcr_audit.log_change(
                    p_user_id     => c_system_user_id,
                    p_operation   => 'UPDATE',
                    p_object_type => 'MCR',
                    p_object_id   => rec.mcr_id,
                    p_old_values  => '{"mcr_status":"Active"}',
                    p_new_values  => '{"mcr_status":"' || l_new_status || '"}'
                );
            END IF;
        END LOOP;
    END run_scheduled_transitions;

END pkg_mcr_lifecycle;
/
