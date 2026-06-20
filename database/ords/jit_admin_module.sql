/*
** jit_admin_module.sql
** ORDS REST Module: jit_admin
** Base Path: /jit/v1/admin/
**
** CRUD handlers for IDCS_TENANCY records, restricted to admin role.
** Requirements: 2.1, 2.2, 2.3
*/

BEGIN
    ORDS.DEFINE_MODULE(
        p_module_name    => 'jit_admin',
        p_base_path      => '/jit/v1/admin/',
        p_items_per_page => 0,
        p_status         => 'PUBLISHED',
        p_comments       => 'Administration endpoints for IDCS tenancy management (admin role required)'
    );

    ---------------------------------------------------------------------------
    -- Template: / (list all tenancies, create new tenancy)
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'jit_admin',
        p_pattern        => '.',
        p_comments       => 'List and create IDCS tenancy records'
    );

    -- GET / handler: list all IDCS tenancy records
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'jit_admin',
        p_pattern        => '.',
        p_method         => 'GET',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user VARCHAR2(200) := NVL(:current_user, V('APP_USER'));
BEGIN
    IF l_user IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'No authenticated session found');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Check admin role (user must be member of JIT_ADMINS group)
    IF NOT APEX_UTIL.CURRENT_USER_IN_GROUP('JIT_ADMINS') THEN
        OWA_UTIL.STATUS_LINE(403, 'Forbidden');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'Admin role required');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.OPEN_ARRAY('items');

    FOR rec IN (
        SELECT tenancy_id, tenancy_identifier, stripe_url, client_id,
               created_at, updated_at
          FROM idcs_tenancy
         ORDER BY tenancy_identifier
    ) LOOP
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('tenancy_id',         rec.tenancy_id);
        APEX_JSON.WRITE('tenancy_identifier', rec.tenancy_identifier);
        APEX_JSON.WRITE('stripe_url',         rec.stripe_url);
        APEX_JSON.WRITE('client_id',          rec.client_id);
        APEX_JSON.WRITE('created_at',         TO_CHAR(rec.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'));
        APEX_JSON.WRITE('updated_at',         TO_CHAR(rec.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'));
        APEX_JSON.CLOSE_OBJECT;
    END LOOP;

    APEX_JSON.CLOSE_ARRAY;
    APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'GET handler - list all IDCS tenancy records'
    );

    -- POST / handler: create new IDCS tenancy record
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'jit_admin',
        p_pattern        => '.',
        p_method         => 'POST',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user               VARCHAR2(200) := NVL(:current_user, V('APP_USER'));
    l_tenancy_identifier VARCHAR2(100);
    l_stripe_url         VARCHAR2(500);
    l_client_id          VARCHAR2(200);
    l_client_secret      VARCHAR2(500);
    l_tenancy_id         NUMBER;
    l_dup_count          NUMBER;
    l_body               CLOB;
BEGIN
    IF l_user IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'No authenticated session found');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Check admin role
    IF NOT APEX_UTIL.CURRENT_USER_IN_GROUP('JIT_ADMINS') THEN
        OWA_UTIL.STATUS_LINE(403, 'Forbidden');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'Admin role required');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Parse request body
    l_body := :body_text;
    APEX_JSON.PARSE(l_body);
    l_tenancy_identifier := APEX_JSON.GET_VARCHAR2(p_path => 'tenancy_identifier');
    l_stripe_url         := APEX_JSON.GET_VARCHAR2(p_path => 'stripe_url');
    l_client_id          := APEX_JSON.GET_VARCHAR2(p_path => 'client_id');
    l_client_secret      := APEX_JSON.GET_VARCHAR2(p_path => 'client_secret');

    -- Validate all required fields
    IF l_tenancy_identifier IS NULL OR l_stripe_url IS NULL
       OR l_client_id IS NULL OR l_client_secret IS NULL THEN
        OWA_UTIL.STATUS_LINE(400, 'Bad Request');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'All fields required: tenancy_identifier, stripe_url, client_id, client_secret');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Validate unique tenancy_identifier
    SELECT COUNT(*) INTO l_dup_count
      FROM idcs_tenancy
     WHERE tenancy_identifier = l_tenancy_identifier;

    IF l_dup_count > 0 THEN
        OWA_UTIL.STATUS_LINE(409, 'Conflict');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'A tenancy with identifier ''' || l_tenancy_identifier || ''' already exists');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Insert new tenancy
    INSERT INTO idcs_tenancy (tenancy_identifier, stripe_url, client_id, client_secret)
    VALUES (l_tenancy_identifier, l_stripe_url, l_client_id, l_client_secret)
    RETURNING tenancy_id INTO l_tenancy_id;

    OWA_UTIL.STATUS_LINE(201, 'Created');
    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.WRITE('tenancy_id',         l_tenancy_id);
    APEX_JSON.WRITE('tenancy_identifier', l_tenancy_identifier);
    APEX_JSON.WRITE('stripe_url',         l_stripe_url);
    APEX_JSON.WRITE('client_id',          l_client_id);
    APEX_JSON.WRITE('created_at',         TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'));
    APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'POST handler - create new IDCS tenancy record'
    );

    ---------------------------------------------------------------------------
    -- Template: /:id (get, update, delete single tenancy)
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'jit_admin',
        p_pattern        => ':id',
        p_comments       => 'Get, update, or delete a single IDCS tenancy record'
    );

    -- GET /:id handler: get single tenancy by ID
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'jit_admin',
        p_pattern        => ':id',
        p_method         => 'GET',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user               VARCHAR2(200) := NVL(:current_user, V('APP_USER'));
    l_id                 NUMBER := :id;
    l_tenancy_identifier VARCHAR2(100);
    l_stripe_url         VARCHAR2(500);
    l_client_id          VARCHAR2(200);
    l_created_at         TIMESTAMP WITH TIME ZONE;
    l_updated_at         TIMESTAMP WITH TIME ZONE;
BEGIN
    IF l_user IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'No authenticated session found');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Check admin role
    IF NOT APEX_UTIL.CURRENT_USER_IN_GROUP('JIT_ADMINS') THEN
        OWA_UTIL.STATUS_LINE(403, 'Forbidden');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'Admin role required');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    BEGIN
        SELECT tenancy_identifier, stripe_url, client_id, created_at, updated_at
          INTO l_tenancy_identifier, l_stripe_url, l_client_id, l_created_at, l_updated_at
          FROM idcs_tenancy
         WHERE tenancy_id = l_id;
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            OWA_UTIL.STATUS_LINE(404, 'Not Found');
            APEX_JSON.OPEN_OBJECT;
            APEX_JSON.WRITE('error', 'Tenancy not found');
            APEX_JSON.CLOSE_OBJECT;
            RETURN;
    END;

    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.WRITE('tenancy_id',         l_id);
    APEX_JSON.WRITE('tenancy_identifier', l_tenancy_identifier);
    APEX_JSON.WRITE('stripe_url',         l_stripe_url);
    APEX_JSON.WRITE('client_id',          l_client_id);
    APEX_JSON.WRITE('created_at',         TO_CHAR(l_created_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'));
    APEX_JSON.WRITE('updated_at',         TO_CHAR(l_updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'));
    APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'GET handler - retrieve single IDCS tenancy by ID'
    );

    -- PUT /:id handler: update existing tenancy
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'jit_admin',
        p_pattern        => ':id',
        p_method         => 'PUT',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user               VARCHAR2(200) := NVL(:current_user, V('APP_USER'));
    l_id                 NUMBER := :id;
    l_tenancy_identifier VARCHAR2(100);
    l_stripe_url         VARCHAR2(500);
    l_client_id          VARCHAR2(200);
    l_client_secret      VARCHAR2(500);
    l_existing_id        VARCHAR2(100);
    l_dup_count          NUMBER;
    l_body               CLOB;
BEGIN
    IF l_user IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'No authenticated session found');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Check admin role
    IF NOT APEX_UTIL.CURRENT_USER_IN_GROUP('JIT_ADMINS') THEN
        OWA_UTIL.STATUS_LINE(403, 'Forbidden');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'Admin role required');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Verify tenancy exists
    BEGIN
        SELECT tenancy_identifier INTO l_existing_id
          FROM idcs_tenancy
         WHERE tenancy_id = l_id;
    EXCEPTION
        WHEN NO_DATA_FOUND THEN
            OWA_UTIL.STATUS_LINE(404, 'Not Found');
            APEX_JSON.OPEN_OBJECT;
            APEX_JSON.WRITE('error', 'Tenancy not found');
            APEX_JSON.CLOSE_OBJECT;
            RETURN;
    END;

    -- Parse request body
    l_body := :body_text;
    APEX_JSON.PARSE(l_body);
    l_tenancy_identifier := APEX_JSON.GET_VARCHAR2(p_path => 'tenancy_identifier');
    l_stripe_url         := APEX_JSON.GET_VARCHAR2(p_path => 'stripe_url');
    l_client_id          := APEX_JSON.GET_VARCHAR2(p_path => 'client_id');
    l_client_secret      := APEX_JSON.GET_VARCHAR2(p_path => 'client_secret');

    -- Validate all required fields
    IF l_tenancy_identifier IS NULL OR l_stripe_url IS NULL
       OR l_client_id IS NULL OR l_client_secret IS NULL THEN
        OWA_UTIL.STATUS_LINE(400, 'Bad Request');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'All fields required: tenancy_identifier, stripe_url, client_id, client_secret');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- If tenancy_identifier changed, validate uniqueness
    IF l_tenancy_identifier != l_existing_id THEN
        SELECT COUNT(*) INTO l_dup_count
          FROM idcs_tenancy
         WHERE tenancy_identifier = l_tenancy_identifier
           AND tenancy_id != l_id;

        IF l_dup_count > 0 THEN
            OWA_UTIL.STATUS_LINE(409, 'Conflict');
            APEX_JSON.OPEN_OBJECT;
            APEX_JSON.WRITE('error', 'A tenancy with identifier ''' || l_tenancy_identifier || ''' already exists');
            APEX_JSON.CLOSE_OBJECT;
            RETURN;
        END IF;
    END IF;

    -- Update the tenancy record
    UPDATE idcs_tenancy
       SET tenancy_identifier = l_tenancy_identifier,
           stripe_url         = l_stripe_url,
           client_id          = l_client_id,
           client_secret      = l_client_secret,
           updated_at         = SYSTIMESTAMP
     WHERE tenancy_id = l_id;

    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.WRITE('tenancy_id',         l_id);
    APEX_JSON.WRITE('tenancy_identifier', l_tenancy_identifier);
    APEX_JSON.WRITE('stripe_url',         l_stripe_url);
    APEX_JSON.WRITE('client_id',          l_client_id);
    APEX_JSON.WRITE('updated_at',         TO_CHAR(SYSTIMESTAMP, 'YYYY-MM-DD"T"HH24:MI:SS.FF3TZH:TZM'));
    APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'PUT handler - update an existing IDCS tenancy record'
    );

    -- DELETE /:id handler: delete tenancy
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'jit_admin',
        p_pattern        => ':id',
        p_method         => 'DELETE',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user       VARCHAR2(200) := NVL(:current_user, V('APP_USER'));
    l_id         NUMBER := :id;
    l_row_count  NUMBER;
BEGIN
    IF l_user IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'No authenticated session found');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Check admin role
    IF NOT APEX_UTIL.CURRENT_USER_IN_GROUP('JIT_ADMINS') THEN
        OWA_UTIL.STATUS_LINE(403, 'Forbidden');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'Admin role required');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Attempt delete
    DELETE FROM idcs_tenancy WHERE tenancy_id = l_id;
    l_row_count := SQL%ROWCOUNT;

    IF l_row_count = 0 THEN
        OWA_UTIL.STATUS_LINE(404, 'Not Found');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'Tenancy not found');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.WRITE('message', 'Tenancy deleted successfully');
    APEX_JSON.WRITE('tenancy_id', l_id);
    APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'DELETE handler - remove an IDCS tenancy record'
    );

    COMMIT;
END;
/
