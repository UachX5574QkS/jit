CREATE OR REPLACE PACKAGE BODY pkg_mcr_core AS
    /*
    ** PKG_MCR_CORE (Body)
    ** Handles MCR record CRUD and RACI assignment management. Provides
    ** procedures for creating, updating, retrieving, and cancelling MCRs,
    ** as well as a function to check Management Group membership.
    **
    ** Requirements 3.3, 3.4, 3.5, 3.7: MCR creation with validation,
    ** RACI assignments, date range checks, and lifecycle operations.
    */

    ----------------------------------------------------------------------------
    -- create_mcr
    --
    -- Creates a new MCR record with Draft status and inserts RACI assignments
    -- from the provided JSON. Validates that all required fields are present
    -- and that the date range is valid (end_date >= start_date).
    ----------------------------------------------------------------------------
    PROCEDURE create_mcr(
        p_user_id        IN NUMBER,
        p_mcr_number     IN VARCHAR2,
        p_owner_user_id  IN NUMBER,
        p_description    IN VARCHAR2,
        p_start_date     IN DATE,
        p_end_date       IN DATE,
        p_raci_json      IN CLOB
    ) IS
        l_mcr_id          NUMBER;
        l_raci_count      NUMBER;
        l_has_responsible  BOOLEAN := FALSE;
        l_has_accountable  BOOLEAN := FALSE;
        l_user_id         NUMBER;
        l_role            VARCHAR2(20);
        l_new_values      CLOB;
    BEGIN
        -----------------------------------------------------------------------
        -- Step 1: Validate required scalar fields
        -----------------------------------------------------------------------
        IF p_mcr_number IS NULL
           OR p_owner_user_id IS NULL
           OR p_description IS NULL
           OR p_start_date IS NULL
           OR p_end_date IS NULL
        THEN
            RAISE_APPLICATION_ERROR(-20001,
                'Missing required fields: MCR Number, Owner, Description, Start Date, and End Date are all required');
        END IF;

        -----------------------------------------------------------------------
        -- Step 2: Parse RACI JSON and validate at least one Responsible
        --         and one Accountable entry
        -----------------------------------------------------------------------
        IF p_raci_json IS NULL OR DBMS_LOB.GETLENGTH(p_raci_json) = 0 THEN
            RAISE_APPLICATION_ERROR(-20001,
                'Missing required fields: RACI assignments JSON is required');
        END IF;

        APEX_JSON.PARSE(p_raci_json);

        l_raci_count := APEX_JSON.GET_COUNT(p_path => '.');

        IF l_raci_count IS NULL OR l_raci_count = 0 THEN
            RAISE_APPLICATION_ERROR(-20001,
                'Missing required fields: At least one Responsible and one Accountable RACI entry required');
        END IF;

        FOR i IN 1 .. l_raci_count LOOP
            l_role := APEX_JSON.GET_VARCHAR2(p_path => '[%d].role', p0 => i);
            IF l_role = 'Responsible' THEN
                l_has_responsible := TRUE;
            ELSIF l_role = 'Accountable' THEN
                l_has_accountable := TRUE;
            END IF;
        END LOOP;

        IF NOT l_has_responsible THEN
            RAISE_APPLICATION_ERROR(-20001,
                'Missing required fields: At least one Responsible RACI entry is required');
        END IF;

        IF NOT l_has_accountable THEN
            RAISE_APPLICATION_ERROR(-20001,
                'Missing required fields: At least one Accountable RACI entry is required');
        END IF;

        -----------------------------------------------------------------------
        -- Step 3: Validate date range (end_date >= start_date)
        -----------------------------------------------------------------------
        IF p_end_date < p_start_date THEN
            RAISE_APPLICATION_ERROR(-20002,
                'Invalid dates: Estimated End Date must be equal to or later than Estimated Start Date');
        END IF;

        -----------------------------------------------------------------------
        -- Step 4: Insert MCR record with Draft status
        -----------------------------------------------------------------------
        INSERT INTO tab_mcr_requests (
            mcr_number,
            owner_user_id,
            description,
            estimated_start_date,
            estimated_end_date,
            mcr_status,
            created_by_user_id,
            created_at,
            updated_at
        ) VALUES (
            p_mcr_number,
            p_owner_user_id,
            p_description,
            p_start_date,
            p_end_date,
            'Draft',
            p_user_id,
            SYSTIMESTAMP,
            SYSTIMESTAMP
        ) RETURNING mcr_id INTO l_mcr_id;

        -----------------------------------------------------------------------
        -- Step 5: Insert RACI assignments from parsed JSON
        -----------------------------------------------------------------------
        FOR i IN 1 .. l_raci_count LOOP
            l_user_id := APEX_JSON.GET_NUMBER(p_path => '[%d].user_id', p0 => i);
            l_role    := APEX_JSON.GET_VARCHAR2(p_path => '[%d].role', p0 => i);

            INSERT INTO tab_mcr_raci (
                mcr_id,
                user_id,
                raci_role
            ) VALUES (
                l_mcr_id,
                l_user_id,
                l_role
            );
        END LOOP;

        -----------------------------------------------------------------------
        -- Step 6: Record creation in audit log
        -----------------------------------------------------------------------
        l_new_values := '{"mcr_number":"' || p_mcr_number
            || '","owner_user_id":' || p_owner_user_id
            || ',"description":"' || REPLACE(REPLACE(p_description, '\', '\\'), '"', '\"')
            || '","estimated_start_date":"' || TO_CHAR(p_start_date, 'YYYY-MM-DD')
            || '","estimated_end_date":"' || TO_CHAR(p_end_date, 'YYYY-MM-DD')
            || '","mcr_status":"Draft"'
            || ',"created_by_user_id":' || p_user_id
            || '}';

        pkg_mcr_audit.log_change(
            p_user_id     => p_user_id,
            p_operation   => 'CREATE',
            p_object_type => 'MCR',
            p_object_id   => l_mcr_id,
            p_old_values  => NULL,
            p_new_values  => l_new_values
        );

        -----------------------------------------------------------------------
        -- Step 7: Return result via APEX_JSON
        -----------------------------------------------------------------------
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('mcr_id', l_mcr_id);
        APEX_JSON.WRITE('status', 'Draft');
        APEX_JSON.CLOSE_OBJECT;

    END create_mcr;


    ----------------------------------------------------------------------------
    -- update_mcr
    --
    -- Updates an existing MCR's description, dates, and RACI assignments.
    -- Only permitted when MCR is in an editable state. Validates date range.
    -- If the MCR was Approved, calls handle_task_modification to revert to
    -- Partial status.
    ----------------------------------------------------------------------------
    PROCEDURE update_mcr(
        p_user_id    IN NUMBER,
        p_mcr_id     IN NUMBER,
        p_description IN VARCHAR2,
        p_start_date IN DATE,
        p_end_date   IN DATE,
        p_raci_json  IN CLOB
    ) IS
        l_status       tab_mcr_requests.mcr_status%TYPE;
        l_old_desc     tab_mcr_requests.description%TYPE;
        l_old_start    tab_mcr_requests.estimated_start_date%TYPE;
        l_old_end      tab_mcr_requests.estimated_end_date%TYPE;
        l_old_values   CLOB;
        l_new_values   CLOB;
        l_raci_count   NUMBER;
        l_user_id      NUMBER;
        l_role         VARCHAR2(20);
    BEGIN
        -----------------------------------------------------------------------
        -- Step 1: Fetch current MCR status and validate editable state
        -----------------------------------------------------------------------
        SELECT mcr_status, description, estimated_start_date, estimated_end_date
          INTO l_status, l_old_desc, l_old_start, l_old_end
          FROM tab_mcr_requests
         WHERE mcr_id = p_mcr_id;

        IF l_status IN ('Locked', 'Active') THEN
            RAISE_APPLICATION_ERROR(-20003,
                'MCR is locked: Cannot modify an MCR in ' || l_status || ' state');
        END IF;

        IF l_status IN ('Complete', 'Partial_Complete', 'Cancelled', 'DNF') THEN
            RAISE_APPLICATION_ERROR(-20004,
                'MCR is archived: Cannot modify an MCR in terminal state ' || l_status);
        END IF;

        -----------------------------------------------------------------------
        -- Step 2: Validate date range (end_date >= start_date)
        -----------------------------------------------------------------------
        IF p_end_date < p_start_date THEN
            RAISE_APPLICATION_ERROR(-20002,
                'Invalid dates: Estimated End Date must be equal to or later than Estimated Start Date');
        END IF;

        -----------------------------------------------------------------------
        -- Step 3: Build JSON of old values for audit
        -----------------------------------------------------------------------
        l_old_values := '{"description":"' || REPLACE(REPLACE(l_old_desc, '\', '\\'), '"', '\"')
            || '","estimated_start_date":"' || TO_CHAR(l_old_start, 'YYYY-MM-DD')
            || '","estimated_end_date":"' || TO_CHAR(l_old_end, 'YYYY-MM-DD')
            || '"}';

        -----------------------------------------------------------------------
        -- Step 4: Update the MCR record
        -----------------------------------------------------------------------
        UPDATE tab_mcr_requests
           SET description          = p_description,
               estimated_start_date = p_start_date,
               estimated_end_date   = p_end_date,
               updated_at           = SYSTIMESTAMP
         WHERE mcr_id = p_mcr_id;

        -----------------------------------------------------------------------
        -- Step 5: Delete existing RACI and re-insert from p_raci_json
        -----------------------------------------------------------------------
        DELETE FROM tab_mcr_raci WHERE mcr_id = p_mcr_id;

        IF p_raci_json IS NOT NULL AND DBMS_LOB.GETLENGTH(p_raci_json) > 0 THEN
            APEX_JSON.PARSE(p_raci_json);
            l_raci_count := APEX_JSON.GET_COUNT(p_path => '.');

            IF l_raci_count IS NOT NULL AND l_raci_count > 0 THEN
                FOR i IN 1 .. l_raci_count LOOP
                    l_user_id := APEX_JSON.GET_NUMBER(p_path => '[%d].user_id', p0 => i);
                    l_role    := APEX_JSON.GET_VARCHAR2(p_path => '[%d].role', p0 => i);

                    INSERT INTO tab_mcr_raci (
                        mcr_id,
                        user_id,
                        raci_role
                    ) VALUES (
                        p_mcr_id,
                        l_user_id,
                        l_role
                    );
                END LOOP;
            END IF;
        END IF;

        -----------------------------------------------------------------------
        -- Step 6: Build new values JSON and call audit log
        -----------------------------------------------------------------------
        l_new_values := '{"description":"' || REPLACE(REPLACE(p_description, '\', '\\'), '"', '\"')
            || '","estimated_start_date":"' || TO_CHAR(p_start_date, 'YYYY-MM-DD')
            || '","estimated_end_date":"' || TO_CHAR(p_end_date, 'YYYY-MM-DD')
            || '"}';

        pkg_mcr_audit.log_change(
            p_user_id     => p_user_id,
            p_operation   => 'UPDATE',
            p_object_type => 'MCR',
            p_object_id   => p_mcr_id,
            p_old_values  => l_old_values,
            p_new_values  => l_new_values
        );

        -----------------------------------------------------------------------
        -- Step 7: If MCR was Approved, revert to Partial
        -----------------------------------------------------------------------
        IF l_status = 'Approved' THEN
            pkg_mcr_lifecycle.handle_task_modification(p_mcr_id);
        END IF;

    END update_mcr;

    ----------------------------------------------------------------------------
    -- get_mcr
    --
    -- Returns MCR details including RACI assignments as JSON output
    -- via APEX_JSON.
    ----------------------------------------------------------------------------
    PROCEDURE get_mcr(
        p_mcr_id IN NUMBER
    ) IS
        l_mcr_number       tab_mcr_requests.mcr_number%TYPE;
        l_owner_user_id    tab_mcr_requests.owner_user_id%TYPE;
        l_owner_name       tab_idcs_users.display_name%TYPE;
        l_description      tab_mcr_requests.description%TYPE;
        l_start_date       tab_mcr_requests.estimated_start_date%TYPE;
        l_end_date         tab_mcr_requests.estimated_end_date%TYPE;
        l_status           tab_mcr_requests.mcr_status%TYPE;
        l_approved_by      tab_mcr_requests.approved_by_user_id%TYPE;
        l_approved_at      tab_mcr_requests.approved_at%TYPE;
        l_created_at       tab_mcr_requests.created_at%TYPE;
        l_updated_at       tab_mcr_requests.updated_at%TYPE;
        l_created_by       tab_mcr_requests.created_by_user_id%TYPE;
    BEGIN
        -----------------------------------------------------------------------
        -- Step 1: Fetch MCR details with owner name
        -----------------------------------------------------------------------
        SELECT m.mcr_number,
               m.owner_user_id,
               u.display_name,
               m.description,
               m.estimated_start_date,
               m.estimated_end_date,
               m.mcr_status,
               m.approved_by_user_id,
               m.approved_at,
               m.created_at,
               m.updated_at,
               m.created_by_user_id
          INTO l_mcr_number,
               l_owner_user_id,
               l_owner_name,
               l_description,
               l_start_date,
               l_end_date,
               l_status,
               l_approved_by,
               l_approved_at,
               l_created_at,
               l_updated_at,
               l_created_by
          FROM tab_mcr_requests m
          JOIN tab_idcs_users u ON u.user_id = m.owner_user_id
         WHERE m.mcr_id = p_mcr_id;

        -----------------------------------------------------------------------
        -- Step 2: Output MCR fields as JSON
        -----------------------------------------------------------------------
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('mcr_id', p_mcr_id);
        APEX_JSON.WRITE('mcr_number', l_mcr_number);
        APEX_JSON.WRITE('owner_user_id', l_owner_user_id);
        APEX_JSON.WRITE('owner_name', l_owner_name);
        APEX_JSON.WRITE('description', l_description);
        APEX_JSON.WRITE('estimated_start_date', TO_CHAR(l_start_date, 'YYYY-MM-DD'));
        APEX_JSON.WRITE('estimated_end_date', TO_CHAR(l_end_date, 'YYYY-MM-DD'));
        APEX_JSON.WRITE('mcr_status', l_status);
        APEX_JSON.WRITE('approved_by_user_id', l_approved_by);
        APEX_JSON.WRITE('approved_at', TO_CHAR(l_approved_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
        APEX_JSON.WRITE('created_at', TO_CHAR(l_created_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
        APEX_JSON.WRITE('updated_at', TO_CHAR(l_updated_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
        APEX_JSON.WRITE('created_by_user_id', l_created_by);

        -----------------------------------------------------------------------
        -- Step 3: Output RACI as array with user details
        -----------------------------------------------------------------------
        APEX_JSON.OPEN_ARRAY('raci');
        FOR rec IN (
            SELECT r.raci_id,
                   r.user_id,
                   u.display_name,
                   u.email,
                   r.raci_role
              FROM tab_mcr_raci r
              JOIN tab_idcs_users u ON u.user_id = r.user_id
             WHERE r.mcr_id = p_mcr_id
             ORDER BY r.raci_role, r.raci_id
        ) LOOP
            APEX_JSON.OPEN_OBJECT;
            APEX_JSON.WRITE('raci_id', rec.raci_id);
            APEX_JSON.WRITE('user_id', rec.user_id);
            APEX_JSON.WRITE('display_name', rec.display_name);
            APEX_JSON.WRITE('email', rec.email);
            APEX_JSON.WRITE('raci_role', rec.raci_role);
            APEX_JSON.CLOSE_OBJECT;
        END LOOP;
        APEX_JSON.CLOSE_ARRAY;

        APEX_JSON.CLOSE_OBJECT;

    END get_mcr;

    ----------------------------------------------------------------------------
    -- get_active_mcrs
    --
    -- Returns all MCRs NOT in terminal states with progress calculation.
    -- Output as JSON array via APEX_JSON.
    ----------------------------------------------------------------------------
    PROCEDURE get_active_mcrs IS
    BEGIN
        APEX_JSON.OPEN_ARRAY;

        FOR rec IN (
            SELECT m.mcr_id,
                   m.mcr_number,
                   m.owner_user_id,
                   u.display_name AS owner_name,
                   m.description,
                   m.estimated_start_date,
                   m.estimated_end_date,
                   m.mcr_status,
                   m.approved_by_user_id,
                   m.approved_at,
                   NVL(tp.tasks_complete, 0)  AS tasks_complete,
                   NVL(tp.total_tasks, 0)     AS total_tasks,
                   NVL(tp.pct_complete, 0)    AS pct_complete
              FROM tab_mcr_requests m
              JOIN tab_idcs_users u ON u.user_id = m.owner_user_id
              LEFT JOIN (
                  SELECT mcr_id,
                         COUNT(CASE WHEN task_status = 'Complete' THEN 1 END) AS tasks_complete,
                         COUNT(*)                                             AS total_tasks,
                         ROUND(
                             COUNT(CASE WHEN task_status = 'Complete' THEN 1 END) * 100.0
                             / NULLIF(COUNT(*), 0), 0
                         ) AS pct_complete
                    FROM tab_mcr_tasks
                   GROUP BY mcr_id
              ) tp ON tp.mcr_id = m.mcr_id
             WHERE m.mcr_status NOT IN ('Complete', 'Partial_Complete', 'Cancelled', 'DNF')
             ORDER BY m.mcr_id
        ) LOOP
            APEX_JSON.OPEN_OBJECT;
            APEX_JSON.WRITE('mcr_id', rec.mcr_id);
            APEX_JSON.WRITE('mcr_number', rec.mcr_number);
            APEX_JSON.WRITE('owner_user_id', rec.owner_user_id);
            APEX_JSON.WRITE('owner_name', rec.owner_name);
            APEX_JSON.WRITE('description', rec.description);
            APEX_JSON.WRITE('estimated_start_date', TO_CHAR(rec.estimated_start_date, 'YYYY-MM-DD'));
            APEX_JSON.WRITE('estimated_end_date', TO_CHAR(rec.estimated_end_date, 'YYYY-MM-DD'));
            APEX_JSON.WRITE('mcr_status', rec.mcr_status);
            APEX_JSON.WRITE('approved_by_user_id', rec.approved_by_user_id);
            APEX_JSON.WRITE('approved_at', TO_CHAR(rec.approved_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
            APEX_JSON.WRITE('tasks_complete', rec.tasks_complete);
            APEX_JSON.WRITE('total_tasks', rec.total_tasks);
            APEX_JSON.WRITE('pct_complete', rec.pct_complete);
            APEX_JSON.CLOSE_OBJECT;
        END LOOP;

        APEX_JSON.CLOSE_ARRAY;

    END get_active_mcrs;

    ----------------------------------------------------------------------------
    -- get_archived_mcrs
    --
    -- Returns all MCRs in terminal states (Complete, Partial_Complete,
    -- Cancelled, DNF) with progress calculation. Output as JSON array.
    ----------------------------------------------------------------------------
    PROCEDURE get_archived_mcrs IS
    BEGIN
        APEX_JSON.OPEN_ARRAY;

        FOR rec IN (
            SELECT m.mcr_id,
                   m.mcr_number,
                   m.owner_user_id,
                   u.display_name AS owner_name,
                   m.description,
                   m.estimated_start_date,
                   m.estimated_end_date,
                   m.mcr_status,
                   m.approved_by_user_id,
                   m.approved_at,
                   NVL(tp.tasks_complete, 0)  AS tasks_complete,
                   NVL(tp.total_tasks, 0)     AS total_tasks,
                   NVL(tp.pct_complete, 0)    AS pct_complete
              FROM tab_mcr_requests m
              JOIN tab_idcs_users u ON u.user_id = m.owner_user_id
              LEFT JOIN (
                  SELECT mcr_id,
                         COUNT(CASE WHEN task_status = 'Complete' THEN 1 END) AS tasks_complete,
                         COUNT(*)                                             AS total_tasks,
                         ROUND(
                             COUNT(CASE WHEN task_status = 'Complete' THEN 1 END) * 100.0
                             / NULLIF(COUNT(*), 0), 0
                         ) AS pct_complete
                    FROM tab_mcr_tasks
                   GROUP BY mcr_id
              ) tp ON tp.mcr_id = m.mcr_id
             WHERE m.mcr_status IN ('Complete', 'Partial_Complete', 'Cancelled', 'DNF')
             ORDER BY m.mcr_id
        ) LOOP
            APEX_JSON.OPEN_OBJECT;
            APEX_JSON.WRITE('mcr_id', rec.mcr_id);
            APEX_JSON.WRITE('mcr_number', rec.mcr_number);
            APEX_JSON.WRITE('owner_user_id', rec.owner_user_id);
            APEX_JSON.WRITE('owner_name', rec.owner_name);
            APEX_JSON.WRITE('description', rec.description);
            APEX_JSON.WRITE('estimated_start_date', TO_CHAR(rec.estimated_start_date, 'YYYY-MM-DD'));
            APEX_JSON.WRITE('estimated_end_date', TO_CHAR(rec.estimated_end_date, 'YYYY-MM-DD'));
            APEX_JSON.WRITE('mcr_status', rec.mcr_status);
            APEX_JSON.WRITE('approved_by_user_id', rec.approved_by_user_id);
            APEX_JSON.WRITE('approved_at', TO_CHAR(rec.approved_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
            APEX_JSON.WRITE('tasks_complete', rec.tasks_complete);
            APEX_JSON.WRITE('total_tasks', rec.total_tasks);
            APEX_JSON.WRITE('pct_complete', rec.pct_complete);
            APEX_JSON.CLOSE_OBJECT;
        END LOOP;

        APEX_JSON.CLOSE_ARRAY;

    END get_archived_mcrs;

    ----------------------------------------------------------------------------
    -- cancel_mcr
    --
    -- Transitions an MCR to Cancelled status. Only permitted from states:
    -- Draft, Review, Active. Records the transition in the audit log.
    ----------------------------------------------------------------------------
    PROCEDURE cancel_mcr(
        p_user_id IN NUMBER,
        p_mcr_id  IN NUMBER
    ) IS
        l_status      tab_mcr_requests.mcr_status%TYPE;
        l_old_values  CLOB;
        l_new_values  CLOB;
    BEGIN
        -----------------------------------------------------------------------
        -- Step 1: Fetch current MCR status
        -----------------------------------------------------------------------
        SELECT mcr_status
          INTO l_status
          FROM tab_mcr_requests
         WHERE mcr_id = p_mcr_id;

        -----------------------------------------------------------------------
        -- Step 2: Validate cancellation is allowed
        -----------------------------------------------------------------------
        IF l_status = 'Locked' THEN
            RAISE_APPLICATION_ERROR(-20003,
                'MCR is locked: Cannot cancel a locked MCR');
        END IF;

        IF l_status IN ('Complete', 'Partial_Complete', 'Cancelled', 'DNF') THEN
            RAISE_APPLICATION_ERROR(-20004,
                'MCR is archived: Cannot cancel an MCR in terminal state ' || l_status);
        END IF;

        IF l_status NOT IN ('Draft', 'Review', 'Active') THEN
            RAISE_APPLICATION_ERROR(-20003,
                'MCR cannot be cancelled from state ' || l_status);
        END IF;

        -----------------------------------------------------------------------
        -- Step 3: Transition to Cancelled
        -----------------------------------------------------------------------
        UPDATE tab_mcr_requests
           SET mcr_status = 'Cancelled',
               updated_at = SYSTIMESTAMP
         WHERE mcr_id = p_mcr_id;

        -----------------------------------------------------------------------
        -- Step 4: Record in audit log
        -----------------------------------------------------------------------
        l_old_values := '{"mcr_status":"' || l_status || '"}';
        l_new_values := '{"mcr_status":"Cancelled"}';

        pkg_mcr_audit.log_change(
            p_user_id     => p_user_id,
            p_operation   => 'UPDATE',
            p_object_type => 'MCR',
            p_object_id   => p_mcr_id,
            p_old_values  => l_old_values,
            p_new_values  => l_new_values
        );

    END cancel_mcr;

    ----------------------------------------------------------------------------
    -- is_management_group
    --
    -- Checks whether the specified user is in the Management Group for a
    -- given MCR. A user is in the Management Group if they are assigned the
    -- Responsible or Accountable role in the MCR's RACI.
    ----------------------------------------------------------------------------
    FUNCTION is_management_group(
        p_user_id IN NUMBER,
        p_mcr_id  IN NUMBER
    ) RETURN BOOLEAN IS
        l_count NUMBER;
    BEGIN
        SELECT COUNT(*)
          INTO l_count
          FROM tab_mcr_raci
         WHERE mcr_id    = p_mcr_id
           AND user_id   = p_user_id
           AND raci_role IN ('Responsible', 'Accountable');

        RETURN l_count > 0;
    END is_management_group;

END pkg_mcr_core;
/
