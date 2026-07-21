/*
** mcr_requests_module.sql
** ORDS REST Module: mcr_requests
** Base Path: /mcr/v1/requests/
**
** Handles MCR CRUD, approval, lock, cancel, partial-changes, report, and
** send-report endpoints. Each handler reads X-User-Id header for identity.
** Requirements: 2.3, 3.3, 7.1, 7.5, 7.10, 11.1, 11.5
*/

BEGIN
    ORDS.DEFINE_MODULE(
        p_module_name    => 'mcr_requests',
        p_base_path      => '/mcr/v1/requests/',
        p_items_per_page => 0,
        p_status         => 'PUBLISHED',
        p_comments       => 'MCR requests CRUD, lifecycle, and reporting'
    );

    ---------------------------------------------------------------------------
    -- Template: . (root)
    -- POST: Create a new MCR
    -- GET: List active MCRs
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_requests',
        p_pattern        => '.',
        p_comments       => 'Create and list active MCRs'
    );

    -- POST /mcr/v1/requests/
    -- Creates a new MCR with Draft status
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_requests',
        p_pattern        => '.',
        p_method         => 'POST',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user_id        NUMBER;
    l_body           CLOB;
    l_mcr_number     VARCHAR2(100);
    l_owner_user_id  NUMBER;
    l_description    VARCHAR2(4000);
    l_start_date     DATE;
    l_end_date       DATE;
    l_raci_json      CLOB;
BEGIN
    l_user_id := TO_NUMBER(:"X-User-Id");

    IF l_user_id IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'X-User-Id header is required');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    l_body := :body_text;
    APEX_JSON.PARSE(l_body);

    l_mcr_number    := APEX_JSON.GET_VARCHAR2(p_path => 'mcr_number');
    l_owner_user_id := APEX_JSON.GET_NUMBER(p_path => 'owner_user_id');
    l_description   := APEX_JSON.GET_VARCHAR2(p_path => 'description');
    l_start_date    := TO_DATE(APEX_JSON.GET_VARCHAR2(p_path => 'start_date'), 'YYYY-MM-DD');
    l_end_date      := TO_DATE(APEX_JSON.GET_VARCHAR2(p_path => 'end_date'), 'YYYY-MM-DD');
    l_raci_json     := APEX_JSON.GET_CLOB(p_path => 'raci');

    PKG_MCR_CORE.create_mcr(
        p_user_id       => l_user_id,
        p_mcr_number    => l_mcr_number,
        p_owner_user_id => l_owner_user_id,
        p_description   => l_description,
        p_start_date    => l_start_date,
        p_end_date      => l_end_date,
        p_raci_json     => l_raci_json
    );

EXCEPTION
    WHEN PKG_MCR_CORE.e_missing_fields THEN
        OWA_UTIL.STATUS_LINE(400, 'Bad Request');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', SQLERRM);
        APEX_JSON.CLOSE_OBJECT;
    WHEN PKG_MCR_CORE.e_invalid_dates THEN
        OWA_UTIL.STATUS_LINE(400, 'Bad Request');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', SQLERRM);
        APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'POST handler - create a new MCR'
    );

    -- GET /mcr/v1/requests/
    -- Returns all active (non-terminal) MCRs
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_requests',
        p_pattern        => '.',
        p_method         => 'GET',
        p_source_type    => 'plsql/block',
        p_source         => q'[
BEGIN
    PKG_MCR_CORE.get_active_mcrs;
END;
]',
        p_comments       => 'GET handler - list active MCRs'
    );

    ---------------------------------------------------------------------------
    -- Template: archived
    -- GET: List archived MCRs
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_requests',
        p_pattern        => 'archived',
        p_comments       => 'List archived (terminal state) MCRs'
    );

    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_requests',
        p_pattern        => 'archived',
        p_method         => 'GET',
        p_source_type    => 'plsql/block',
        p_source         => q'[
BEGIN
    PKG_MCR_CORE.get_archived_mcrs;
END;
]',
        p_comments       => 'GET handler - list archived MCRs'
    );

    ---------------------------------------------------------------------------
    -- Template: :id
    -- GET: Get MCR details
    -- PUT: Update MCR
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_requests',
        p_pattern        => ':id',
        p_comments       => 'Single MCR operations (get, update)'
    );

    -- GET /mcr/v1/requests/:id
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_requests',
        p_pattern        => ':id',
        p_method         => 'GET',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_mcr_id NUMBER;
BEGIN
    l_mcr_id := TO_NUMBER(:id);
    PKG_MCR_CORE.get_mcr(p_mcr_id => l_mcr_id);
END;
]',
        p_comments       => 'GET handler - get MCR details'
    );

    -- PUT /mcr/v1/requests/:id
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_requests',
        p_pattern        => ':id',
        p_method         => 'PUT',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user_id     NUMBER;
    l_mcr_id      NUMBER;
    l_body        CLOB;
    l_description VARCHAR2(4000);
    l_start_date  DATE;
    l_end_date    DATE;
    l_raci_json   CLOB;
BEGIN
    l_user_id := TO_NUMBER(:"X-User-Id");
    l_mcr_id  := TO_NUMBER(:id);

    IF l_user_id IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'X-User-Id header is required');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    l_body := :body_text;
    APEX_JSON.PARSE(l_body);

    l_description := APEX_JSON.GET_VARCHAR2(p_path => 'description');
    l_start_date  := TO_DATE(APEX_JSON.GET_VARCHAR2(p_path => 'start_date'), 'YYYY-MM-DD');
    l_end_date    := TO_DATE(APEX_JSON.GET_VARCHAR2(p_path => 'end_date'), 'YYYY-MM-DD');
    l_raci_json   := APEX_JSON.GET_CLOB(p_path => 'raci');

    PKG_MCR_CORE.update_mcr(
        p_user_id     => l_user_id,
        p_mcr_id      => l_mcr_id,
        p_description => l_description,
        p_start_date  => l_start_date,
        p_end_date    => l_end_date,
        p_raci_json   => l_raci_json
    );

EXCEPTION
    WHEN PKG_MCR_CORE.e_mcr_locked THEN
        OWA_UTIL.STATUS_LINE(409, 'Conflict');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'MCR is locked and cannot be modified');
        APEX_JSON.CLOSE_OBJECT;
    WHEN PKG_MCR_CORE.e_mcr_archived THEN
        OWA_UTIL.STATUS_LINE(409, 'Conflict');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'MCR is in a terminal state and read-only');
        APEX_JSON.CLOSE_OBJECT;
    WHEN PKG_MCR_CORE.e_invalid_dates THEN
        OWA_UTIL.STATUS_LINE(400, 'Bad Request');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', SQLERRM);
        APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'PUT handler - update MCR details'
    );

    ---------------------------------------------------------------------------
    -- Template: :id/approve
    -- PUT: Approve an MCR
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_requests',
        p_pattern        => ':id/approve',
        p_comments       => 'Approve an MCR (Management Group only)'
    );

    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_requests',
        p_pattern        => ':id/approve',
        p_method         => 'PUT',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user_id NUMBER;
    l_mcr_id  NUMBER;
BEGIN
    l_user_id := TO_NUMBER(:"X-User-Id");
    l_mcr_id  := TO_NUMBER(:id);

    IF l_user_id IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'X-User-Id header is required');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    PKG_MCR_LIFECYCLE.approve_mcr(
        p_user_id => l_user_id,
        p_mcr_id  => l_mcr_id
    );

EXCEPTION
    WHEN PKG_MCR_LIFECYCLE.e_not_pending THEN
        OWA_UTIL.STATUS_LINE(409, 'Conflict');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'MCR is not in Pending status');
        APEX_JSON.CLOSE_OBJECT;
    WHEN PKG_MCR_LIFECYCLE.e_insufficient_perm THEN
        OWA_UTIL.STATUS_LINE(403, 'Forbidden');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'User is not in the Management Group');
        APEX_JSON.CLOSE_OBJECT;
    WHEN PKG_MCR_LIFECYCLE.e_prerequisites_failed THEN
        OWA_UTIL.STATUS_LINE(400, 'Bad Request');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', SQLERRM);
        APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'PUT handler - approve MCR'
    );

    ---------------------------------------------------------------------------
    -- Template: :id/lock
    -- PUT: Lock an MCR
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_requests',
        p_pattern        => ':id/lock',
        p_comments       => 'Lock an approved MCR'
    );

    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_requests',
        p_pattern        => ':id/lock',
        p_method         => 'PUT',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user_id NUMBER;
    l_mcr_id  NUMBER;
BEGIN
    l_user_id := TO_NUMBER(:"X-User-Id");
    l_mcr_id  := TO_NUMBER(:id);

    IF l_user_id IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'X-User-Id header is required');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    PKG_MCR_LIFECYCLE.lock_mcr(
        p_user_id => l_user_id,
        p_mcr_id  => l_mcr_id
    );

EXCEPTION
    WHEN PKG_MCR_LIFECYCLE.e_not_approved THEN
        OWA_UTIL.STATUS_LINE(409, 'Conflict');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'MCR is not in Approved status');
        APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'PUT handler - lock MCR'
    );

    ---------------------------------------------------------------------------
    -- Template: :id/cancel
    -- PUT: Cancel an MCR
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_requests',
        p_pattern        => ':id/cancel',
        p_comments       => 'Cancel an MCR'
    );

    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_requests',
        p_pattern        => ':id/cancel',
        p_method         => 'PUT',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user_id NUMBER;
    l_mcr_id  NUMBER;
BEGIN
    l_user_id := TO_NUMBER(:"X-User-Id");
    l_mcr_id  := TO_NUMBER(:id);

    IF l_user_id IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'X-User-Id header is required');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    PKG_MCR_CORE.cancel_mcr(
        p_user_id => l_user_id,
        p_mcr_id  => l_mcr_id
    );

EXCEPTION
    WHEN PKG_MCR_CORE.e_mcr_locked THEN
        OWA_UTIL.STATUS_LINE(409, 'Conflict');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'Cannot cancel a locked MCR');
        APEX_JSON.CLOSE_OBJECT;
    WHEN PKG_MCR_CORE.e_mcr_archived THEN
        OWA_UTIL.STATUS_LINE(409, 'Conflict');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'MCR is already in a terminal state');
        APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'PUT handler - cancel MCR'
    );

    ---------------------------------------------------------------------------
    -- Template: :id/partial-changes
    -- GET: Get tasks changed since last approval
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_requests',
        p_pattern        => ':id/partial-changes',
        p_comments       => 'Get tasks changed since last approval'
    );

    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_requests',
        p_pattern        => ':id/partial-changes',
        p_method         => 'GET',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_mcr_id NUMBER;
BEGIN
    l_mcr_id := TO_NUMBER(:id);
    PKG_MCR_LIFECYCLE.get_partial_changes(p_mcr_id => l_mcr_id);
END;
]',
        p_comments       => 'GET handler - tasks changed since last approval'
    );

    ---------------------------------------------------------------------------
    -- Template: :id/report
    -- GET: Generate MCR report
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_requests',
        p_pattern        => ':id/report',
        p_comments       => 'Generate MCR report'
    );

    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_requests',
        p_pattern        => ':id/report',
        p_method         => 'GET',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_mcr_id NUMBER;
BEGIN
    l_mcr_id := TO_NUMBER(:id);
    PKG_MCR_REPORTS.generate_report(p_mcr_id => l_mcr_id);
END;
]',
        p_comments       => 'GET handler - generate MCR report'
    );

    ---------------------------------------------------------------------------
    -- Template: :id/send-report
    -- POST: Email report to Informed RACI group
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_requests',
        p_pattern        => ':id/send-report',
        p_comments       => 'Send MCR report via email'
    );

    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_requests',
        p_pattern        => ':id/send-report',
        p_method         => 'POST',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user_id NUMBER;
    l_mcr_id  NUMBER;
BEGIN
    l_user_id := TO_NUMBER(:"X-User-Id");
    l_mcr_id  := TO_NUMBER(:id);

    IF l_user_id IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'X-User-Id header is required');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    PKG_MCR_REPORTS.send_report_email(
        p_mcr_id  => l_mcr_id,
        p_user_id => l_user_id
    );

    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.WRITE('status', 'sent');
    APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'POST handler - send report email to Informed group'
    );

    COMMIT;
END;
/
