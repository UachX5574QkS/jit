SET SERVEROUTPUT ON
SET DEFINE OFF

-- Set workspace context
BEGIN
    APEX_UTIL.SET_SECURITY_GROUP_ID(p_security_group_id => 9828571570829271);
END;
/

------------------------------------------------------------
-- UPLOAD STATIC FILES (CSS, SVGs, index.html)
------------------------------------------------------------

-- Upload index.html
DECLARE
    l_blob BLOB;
    l_clob CLOB := '<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="#APP_FILES#favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>JIT Break Glass</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>';
    l_dest_offset INTEGER := 1;
    l_src_offset INTEGER := 1;
    l_lang_context INTEGER := DBMS_LOB.DEFAULT_LANG_CTX;
    l_warning INTEGER;
BEGIN
    DBMS_LOB.CREATETEMPORARY(l_blob, TRUE);
    DBMS_LOB.CONVERTTOBLOB(l_blob, l_clob, DBMS_LOB.LOBMAXSIZE,
        l_dest_offset, l_src_offset, DBMS_LOB.DEFAULT_CSID, l_lang_context, l_warning);
    WWV_FLOW_IMP.CREATE_APP_STATIC_FILE(
        p_id => NULL, p_flow_id => 100,
        p_file_name => 'index.html', p_mime_type => 'text/html',
        p_file_charset => 'utf-8', p_file_content => l_blob);
    DBMS_LOB.FREETEMPORARY(l_blob);
    COMMIT;
    DBMS_OUTPUT.PUT_LINE('Uploaded: index.html');
END;
/

------------------------------------------------------------
-- TABLES
------------------------------------------------------------

CREATE TABLE idcs_tenancy (
    tenancy_id       NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenancy_name     VARCHAR2(200) NOT NULL,
    tenancy_url      VARCHAR2(500) NOT NULL,
    client_id        VARCHAR2(500),
    client_secret    VARCHAR2(500),
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP,
    updated_at       TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP
);

CREATE TABLE break_glass_event (
    event_id         NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type       VARCHAR2(50) NOT NULL CHECK (event_type IN ('group','password')),
    target_name      VARCHAR2(200) NOT NULL,
    requested_by     VARCHAR2(200) NOT NULL,
    approved_by      VARCHAR2(200),
    status           VARCHAR2(50) DEFAULT 'started' NOT NULL,
    reason           VARCHAR2(4000),
    duration_minutes NUMBER,
    start_time       TIMESTAMP WITH TIME ZONE,
    end_time         TIMESTAMP WITH TIME ZONE,
    created_at       TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP,
    updated_at       TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP
);

CREATE TABLE event_status_history (
    history_id       NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id         NUMBER NOT NULL REFERENCES break_glass_event(event_id),
    old_status       VARCHAR2(50),
    new_status       VARCHAR2(50) NOT NULL,
    changed_by       VARCHAR2(200),
    changed_at       TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP,
    notes            VARCHAR2(4000)
);

CREATE TABLE password_reveal_log (
    log_id           NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id         NUMBER NOT NULL REFERENCES break_glass_event(event_id),
    revealed_by      VARCHAR2(200) NOT NULL,
    revealed_at      TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP,
    reset_at         TIMESTAMP WITH TIME ZONE
);

PROMPT Tables created successfully

------------------------------------------------------------
-- INDEXES
------------------------------------------------------------

CREATE INDEX idx_bge_status ON break_glass_event(status);
CREATE INDEX idx_bge_requested_by ON break_glass_event(requested_by);
CREATE INDEX idx_bge_event_type ON break_glass_event(event_type);
CREATE INDEX idx_esh_event_id ON event_status_history(event_id);
CREATE INDEX idx_prl_event_id ON password_reveal_log(event_id);

PROMPT Indexes created successfully

------------------------------------------------------------
-- ORDS MODULES (no OAuth - open access for demo)
------------------------------------------------------------

-- Auth module
BEGIN
    ORDS.DEFINE_MODULE(p_module_name => 'jit_auth', p_base_path => '/jit/v1/auth/', p_items_per_page => 0, p_status => 'PUBLISHED');
    ORDS.DEFINE_TEMPLATE(p_module_name => 'jit_auth', p_pattern => '.');
    ORDS.DEFINE_HANDLER(p_module_name => 'jit_auth', p_pattern => '.', p_method => 'GET', p_source_type => 'plsql/block',
        p_source => '
BEGIN
    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.WRITE(''user'', NVL(V(''APP_USER''), ''demo_user''));
    APEX_JSON.WRITE(''display_name'', ''Demo User'');
    APEX_JSON.WRITE(''email'', ''demo@example.com'');
    APEX_JSON.CLOSE_OBJECT;
END;');
    COMMIT;
    DBMS_OUTPUT.PUT_LINE('Created: jit_auth');
END;
/

-- Targets module
BEGIN
    ORDS.DEFINE_MODULE(p_module_name => 'jit_targets', p_base_path => '/jit/v1/targets/', p_items_per_page => 0, p_status => 'PUBLISHED');
    ORDS.DEFINE_TEMPLATE(p_module_name => 'jit_targets', p_pattern => '.');
    ORDS.DEFINE_HANDLER(p_module_name => 'jit_targets', p_pattern => '.', p_method => 'GET', p_source_type => 'plsql/block',
        p_source => '
BEGIN
    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.OPEN_ARRAY(''items'');
    APEX_JSON.CLOSE_ARRAY;
    APEX_JSON.CLOSE_OBJECT;
END;');
    ORDS.DEFINE_TEMPLATE(p_module_name => 'jit_targets', p_pattern => ':target_type/:target_name/approvers');
    ORDS.DEFINE_HANDLER(p_module_name => 'jit_targets', p_pattern => ':target_type/:target_name/approvers', p_method => 'GET', p_source_type => 'plsql/block',
        p_source => '
BEGIN
    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.OPEN_ARRAY(''approvers'');
    APEX_JSON.CLOSE_ARRAY;
    APEX_JSON.CLOSE_OBJECT;
END;');
    COMMIT;
    DBMS_OUTPUT.PUT_LINE('Created: jit_targets');
END;
/

-- Events module
BEGIN
    ORDS.DEFINE_MODULE(p_module_name => 'jit_events', p_base_path => '/jit/v1/events/', p_items_per_page => 0, p_status => 'PUBLISHED');
    ORDS.DEFINE_TEMPLATE(p_module_name => 'jit_events', p_pattern => '.');
    ORDS.DEFINE_HANDLER(p_module_name => 'jit_events', p_pattern => '.', p_method => 'GET', p_source_type => 'plsql/block',
        p_source => '
DECLARE
    CURSOR c_events IS
        SELECT event_id, event_type, target_name, requested_by, status,
               reason, duration_minutes,
               TO_CHAR(start_time, ''YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'') start_time,
               TO_CHAR(end_time, ''YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'') end_time,
               TO_CHAR(created_at, ''YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'') created_at
        FROM break_glass_event
        ORDER BY created_at DESC;
BEGIN
    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.OPEN_ARRAY(''items'');
    FOR r IN c_events LOOP
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE(''event_id'', r.event_id);
        APEX_JSON.WRITE(''event_type'', r.event_type);
        APEX_JSON.WRITE(''target_name'', r.target_name);
        APEX_JSON.WRITE(''requested_by'', r.requested_by);
        APEX_JSON.WRITE(''status'', r.status);
        APEX_JSON.WRITE(''reason'', r.reason);
        APEX_JSON.WRITE(''duration_minutes'', r.duration_minutes);
        APEX_JSON.WRITE(''start_time'', r.start_time);
        APEX_JSON.WRITE(''end_time'', r.end_time);
        APEX_JSON.WRITE(''created_at'', r.created_at);
        APEX_JSON.CLOSE_OBJECT;
    END LOOP;
    APEX_JSON.CLOSE_ARRAY;
    APEX_JSON.CLOSE_OBJECT;
END;');
    ORDS.DEFINE_HANDLER(p_module_name => 'jit_events', p_pattern => '.', p_method => 'POST', p_source_type => 'plsql/block',
        p_source => '
DECLARE
    l_event_id NUMBER;
    l_body CLOB := :body_text;
    l_event_type VARCHAR2(50);
    l_target_name VARCHAR2(200);
    l_reason VARCHAR2(4000);
    l_duration NUMBER;
BEGIN
    APEX_JSON.PARSE(l_body);
    l_event_type := APEX_JSON.GET_VARCHAR2(p_path => ''event_type'');
    l_target_name := APEX_JSON.GET_VARCHAR2(p_path => ''target_name'');
    l_reason := APEX_JSON.GET_VARCHAR2(p_path => ''reason'');
    l_duration := APEX_JSON.GET_NUMBER(p_path => ''duration_minutes'');

    INSERT INTO break_glass_event (event_type, target_name, requested_by, status, reason, duration_minutes)
    VALUES (l_event_type, l_target_name, NVL(V(''APP_USER''), ''demo_user''), ''started'', l_reason, l_duration)
    RETURNING event_id INTO l_event_id;

    INSERT INTO event_status_history (event_id, new_status, changed_by)
    VALUES (l_event_id, ''started'', NVL(V(''APP_USER''), ''demo_user''));

    COMMIT;

    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.WRITE(''event_id'', l_event_id);
    APEX_JSON.WRITE(''status'', ''started'');
    APEX_JSON.WRITE(''created_at'', TO_CHAR(SYSTIMESTAMP, ''YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM''));
    APEX_JSON.CLOSE_OBJECT;
END;');
    COMMIT;
    DBMS_OUTPUT.PUT_LINE('Created: jit_events');
END;
/

-- Approvals module
BEGIN
    ORDS.DEFINE_MODULE(p_module_name => 'jit_approvals', p_base_path => '/jit/v1/approvals/', p_items_per_page => 0, p_status => 'PUBLISHED');
    ORDS.DEFINE_TEMPLATE(p_module_name => 'jit_approvals', p_pattern => '.');
    ORDS.DEFINE_HANDLER(p_module_name => 'jit_approvals', p_pattern => '.', p_method => 'GET', p_source_type => 'plsql/block',
        p_source => '
BEGIN
    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.OPEN_ARRAY(''items'');
    FOR r IN (SELECT event_id, event_type, target_name, requested_by, status,
                     TO_CHAR(created_at, ''YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'') created_at
              FROM break_glass_event WHERE status = ''approval_pending'' ORDER BY created_at DESC) LOOP
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE(''event_id'', r.event_id);
        APEX_JSON.WRITE(''event_type'', r.event_type);
        APEX_JSON.WRITE(''target_name'', r.target_name);
        APEX_JSON.WRITE(''requested_by'', r.requested_by);
        APEX_JSON.WRITE(''status'', r.status);
        APEX_JSON.WRITE(''created_at'', r.created_at);
        APEX_JSON.CLOSE_OBJECT;
    END LOOP;
    APEX_JSON.CLOSE_ARRAY;
    APEX_JSON.CLOSE_OBJECT;
END;');
    ORDS.DEFINE_TEMPLATE(p_module_name => 'jit_approvals', p_pattern => ':event_id');
    ORDS.DEFINE_HANDLER(p_module_name => 'jit_approvals', p_pattern => ':event_id', p_method => 'POST', p_source_type => 'plsql/block',
        p_source => '
DECLARE
    l_body CLOB := :body_text;
    l_action VARCHAR2(50);
    l_new_status VARCHAR2(50);
    l_event_id NUMBER := :event_id;
BEGIN
    APEX_JSON.PARSE(l_body);
    l_action := APEX_JSON.GET_VARCHAR2(p_path => ''action'');
    l_new_status := CASE WHEN l_action = ''APPROVE'' THEN ''approved'' ELSE ''denied'' END;

    UPDATE break_glass_event SET status = l_new_status, approved_by = NVL(V(''APP_USER''), ''demo_user''), updated_at = SYSTIMESTAMP
    WHERE event_id = l_event_id;

    INSERT INTO event_status_history (event_id, old_status, new_status, changed_by)
    VALUES (l_event_id, ''approval_pending'', l_new_status, NVL(V(''APP_USER''), ''demo_user''));

    COMMIT;

    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.WRITE(''event_id'', l_event_id);
    APEX_JSON.WRITE(''status'', l_new_status);
    APEX_JSON.WRITE(''actioned_at'', TO_CHAR(SYSTIMESTAMP, ''YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM''));
    APEX_JSON.CLOSE_OBJECT;
END;');
    COMMIT;
    DBMS_OUTPUT.PUT_LINE('Created: jit_approvals');
END;
/

-- Password module
BEGIN
    ORDS.DEFINE_MODULE(p_module_name => 'jit_password', p_base_path => '/jit/v1/password/', p_items_per_page => 0, p_status => 'PUBLISHED');
    ORDS.DEFINE_TEMPLATE(p_module_name => 'jit_password', p_pattern => 'reveal');
    ORDS.DEFINE_HANDLER(p_module_name => 'jit_password', p_pattern => 'reveal', p_method => 'POST', p_source_type => 'plsql/block',
        p_source => '
DECLARE
    l_body CLOB := :body_text;
    l_event_id NUMBER;
    l_password VARCHAR2(100) := DBMS_RANDOM.STRING(''x'', 20);
BEGIN
    APEX_JSON.PARSE(l_body);
    l_event_id := APEX_JSON.GET_NUMBER(p_path => ''event_id'');

    INSERT INTO password_reveal_log (event_id, revealed_by)
    VALUES (l_event_id, NVL(V(''APP_USER''), ''demo_user''));

    UPDATE break_glass_event SET status = ''password_revealed'', updated_at = SYSTIMESTAMP
    WHERE event_id = l_event_id;

    COMMIT;

    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.WRITE(''password'', l_password);
    APEX_JSON.WRITE(''expires_in_minutes'', 15);
    APEX_JSON.CLOSE_OBJECT;
END;');
    COMMIT;
    DBMS_OUTPUT.PUT_LINE('Created: jit_password');
END;
/

-- Admin module
BEGIN
    ORDS.DEFINE_MODULE(p_module_name => 'jit_admin', p_base_path => '/jit/v1/admin/', p_items_per_page => 0, p_status => 'PUBLISHED');
    ORDS.DEFINE_TEMPLATE(p_module_name => 'jit_admin', p_pattern => 'tenancies/');
    ORDS.DEFINE_HANDLER(p_module_name => 'jit_admin', p_pattern => 'tenancies/', p_method => 'GET', p_source_type => 'plsql/block',
        p_source => '
BEGIN
    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.OPEN_ARRAY(''items'');
    FOR r IN (SELECT tenancy_id, tenancy_name, tenancy_url, client_id,
                     TO_CHAR(created_at, ''YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'') created_at
              FROM idcs_tenancy ORDER BY tenancy_name) LOOP
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE(''tenancy_id'', r.tenancy_id);
        APEX_JSON.WRITE(''tenancy_name'', r.tenancy_name);
        APEX_JSON.WRITE(''tenancy_url'', r.tenancy_url);
        APEX_JSON.WRITE(''client_id'', r.client_id);
        APEX_JSON.WRITE(''created_at'', r.created_at);
        APEX_JSON.CLOSE_OBJECT;
    END LOOP;
    APEX_JSON.CLOSE_ARRAY;
    APEX_JSON.CLOSE_OBJECT;
END;');
    ORDS.DEFINE_HANDLER(p_module_name => 'jit_admin', p_pattern => 'tenancies/', p_method => 'POST', p_source_type => 'plsql/block',
        p_source => '
DECLARE
    l_body CLOB := :body_text;
    l_id NUMBER;
BEGIN
    APEX_JSON.PARSE(l_body);
    INSERT INTO idcs_tenancy (tenancy_name, tenancy_url, client_id, client_secret)
    VALUES (APEX_JSON.GET_VARCHAR2(''tenancy_name''), APEX_JSON.GET_VARCHAR2(''tenancy_url''),
            APEX_JSON.GET_VARCHAR2(''client_id''), APEX_JSON.GET_VARCHAR2(''client_secret''))
    RETURNING tenancy_id INTO l_id;
    COMMIT;
    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.WRITE(''tenancy_id'', l_id);
    APEX_JSON.WRITE(''tenancy_name'', APEX_JSON.GET_VARCHAR2(''tenancy_name''));
    APEX_JSON.CLOSE_OBJECT;
END;');
    COMMIT;
    DBMS_OUTPUT.PUT_LINE('Created: jit_admin');
END;
/

------------------------------------------------------------
-- VERIFY
------------------------------------------------------------
SELECT table_name FROM user_tables WHERE table_name != 'DBTOOLS$MCP_LOG' ORDER BY table_name;
SELECT name, uri_prefix, status FROM user_ords_modules ORDER BY name;
SELECT file_name FROM apex_application_static_files WHERE application_id = 100 ORDER BY file_name;

EXIT;
