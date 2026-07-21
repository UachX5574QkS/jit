/*
** mcr_documents_module.sql
** ORDS REST Module: mcr_documents
** Base Path: /mcr/v1/documents/
**
** Handles document upload, retrieval, and task-document link management.
** Requirements: 6.1, 6.3, 6.5
*/

BEGIN
    ORDS.DEFINE_MODULE(
        p_module_name    => 'mcr_documents',
        p_base_path      => '/mcr/v1/documents/',
        p_items_per_page => 0,
        p_status         => 'PUBLISHED',
        p_comments       => 'MCR document upload, retrieval, and task-document linking'
    );

    ---------------------------------------------------------------------------
    -- Template: :mcr_id
    -- GET  → List all documents for an MCR
    -- POST → Upload a new document to an MCR
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_documents',
        p_pattern        => ':mcr_id',
        p_comments       => 'Get or upload documents for a specific MCR'
    );

    ---------------------------------------------------------------------------
    -- GET /mcr/v1/documents/:mcr_id
    -- Returns all documents uploaded to the given MCR.
    -- Calls PKG_MCR_DOCS.get_mcr_documents and serializes the cursor as JSON.
    ---------------------------------------------------------------------------
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_documents',
        p_pattern        => ':mcr_id',
        p_method         => 'GET',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user_id           NUMBER;
    l_cursor            SYS_REFCURSOR;
    l_document_id       NUMBER;
    l_mcr_id            NUMBER;
    l_title             VARCHAR2(255);
    l_content_type      VARCHAR2(200);
    l_uploaded_by       NUMBER;
    l_uploaded_at       TIMESTAMP;
BEGIN
    l_user_id := TO_NUMBER(:"X-User-Id");

    IF l_user_id IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'X-User-Id header is required');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    l_cursor := PKG_MCR_DOCS.get_mcr_documents(p_mcr_id => TO_NUMBER(:mcr_id));

    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.OPEN_ARRAY('items');

    LOOP
        FETCH l_cursor INTO
            l_document_id, l_mcr_id, l_title, l_content_type,
            l_uploaded_by, l_uploaded_at;
        EXIT WHEN l_cursor%NOTFOUND;

        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('document_id',        l_document_id);
        APEX_JSON.WRITE('mcr_id',             l_mcr_id);
        APEX_JSON.WRITE('title',              l_title);
        APEX_JSON.WRITE('content_type',       l_content_type);
        APEX_JSON.WRITE('uploaded_by_user_id', l_uploaded_by);
        APEX_JSON.WRITE('uploaded_at',        TO_CHAR(l_uploaded_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3'));
        APEX_JSON.CLOSE_OBJECT;
    END LOOP;

    CLOSE l_cursor;

    APEX_JSON.CLOSE_ARRAY;
    APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'GET handler - returns all documents for the specified MCR'
    );

    ---------------------------------------------------------------------------
    -- POST /mcr/v1/documents/:mcr_id
    -- Uploads a new document to the MCR. Accepts JSON body with title and
    -- optional base64 content, or just a title for MVP (empty BLOB).
    -- Calls PKG_MCR_DOCS.upload_document.
    ---------------------------------------------------------------------------
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_documents',
        p_pattern        => ':mcr_id',
        p_method         => 'POST',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user_id       NUMBER;
    l_body          CLOB;
    l_title         VARCHAR2(255);
    l_content_type  VARCHAR2(200);
    l_content_b64   CLOB;
    l_content       BLOB;
BEGIN
    l_user_id := TO_NUMBER(:"X-User-Id");

    IF l_user_id IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'X-User-Id header is required');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Parse JSON request body
    l_body := :body_text;
    APEX_JSON.PARSE(l_body);

    l_title        := APEX_JSON.GET_VARCHAR2(p_path => 'title');
    l_content_type := NVL(APEX_JSON.GET_VARCHAR2(p_path => 'content_type'), 'application/octet-stream');
    l_content_b64  := APEX_JSON.GET_CLOB(p_path => 'content');

    -- Decode base64 content if provided, otherwise use empty BLOB
    IF l_content_b64 IS NOT NULL AND DBMS_LOB.GETLENGTH(l_content_b64) > 0 THEN
        l_content := APEX_WEB_SERVICE.CLOBBASE642BLOB(p_clob => l_content_b64);
    ELSE
        DBMS_LOB.CREATETEMPORARY(l_content, TRUE);
    END IF;

    -- Call the package procedure
    BEGIN
        PKG_MCR_DOCS.upload_document(
            p_user_id      => l_user_id,
            p_mcr_id       => TO_NUMBER(:mcr_id),
            p_title        => l_title,
            p_content      => l_content,
            p_content_type => l_content_type
        );
    EXCEPTION
        WHEN PKG_MCR_DOCS.e_invalid_title THEN
            OWA_UTIL.STATUS_LINE(400, 'Bad Request');
            APEX_JSON.OPEN_OBJECT;
            APEX_JSON.OPEN_OBJECT('error');
            APEX_JSON.WRITE('code', 'INVALID_TITLE');
            APEX_JSON.WRITE('message', SQLERRM);
            APEX_JSON.CLOSE_OBJECT;
            APEX_JSON.CLOSE_OBJECT;

            IF DBMS_LOB.ISTEMPORARY(l_content) = 1 THEN
                DBMS_LOB.FREETEMPORARY(l_content);
            END IF;
            RETURN;
    END;

    -- Free temp BLOB if created
    IF DBMS_LOB.ISTEMPORARY(l_content) = 1 THEN
        DBMS_LOB.FREETEMPORARY(l_content);
    END IF;

    -- Return 201 Created
    OWA_UTIL.STATUS_LINE(201, 'Created');
    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.WRITE('status', 'uploaded');
    APEX_JSON.WRITE('message', 'Document uploaded successfully');
    APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'POST handler - uploads a new document to the MCR'
    );

    ---------------------------------------------------------------------------
    -- Template: :task_id/links
    -- GET → List documents linked to a task
    -- PUT → Update (reconcile) document-task associations
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_documents',
        p_pattern        => ':task_id/links',
        p_comments       => 'Get or update document links for a specific task'
    );

    ---------------------------------------------------------------------------
    -- GET /mcr/v1/documents/:task_id/links
    -- Returns all documents linked to the specified task.
    -- Calls PKG_MCR_DOCS.get_task_documents and serializes the cursor as JSON.
    ---------------------------------------------------------------------------
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_documents',
        p_pattern        => ':task_id/links',
        p_method         => 'GET',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user_id           NUMBER;
    l_cursor            SYS_REFCURSOR;
    l_document_id       NUMBER;
    l_title             VARCHAR2(255);
    l_content_type      VARCHAR2(200);
    l_uploaded_by       NUMBER;
    l_uploaded_at       TIMESTAMP;
BEGIN
    l_user_id := TO_NUMBER(:"X-User-Id");

    IF l_user_id IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'X-User-Id header is required');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    l_cursor := PKG_MCR_DOCS.get_task_documents(p_task_id => TO_NUMBER(:task_id));

    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.OPEN_ARRAY('items');

    LOOP
        FETCH l_cursor INTO
            l_document_id, l_title, l_content_type,
            l_uploaded_by, l_uploaded_at;
        EXIT WHEN l_cursor%NOTFOUND;

        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('document_id',        l_document_id);
        APEX_JSON.WRITE('title',              l_title);
        APEX_JSON.WRITE('content_type',       l_content_type);
        APEX_JSON.WRITE('uploaded_by_user_id', l_uploaded_by);
        APEX_JSON.WRITE('uploaded_at',        TO_CHAR(l_uploaded_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF3'));
        APEX_JSON.CLOSE_OBJECT;
    END LOOP;

    CLOSE l_cursor;

    APEX_JSON.CLOSE_ARRAY;
    APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'GET handler - returns documents linked to the specified task'
    );

    ---------------------------------------------------------------------------
    -- PUT /mcr/v1/documents/:task_id/links
    -- Reconciles document-task links. Accepts JSON body with document_ids
    -- (comma-separated string or JSON array). Calls PKG_MCR_DOCS.update_task_links.
    ---------------------------------------------------------------------------
    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_documents',
        p_pattern        => ':task_id/links',
        p_method         => 'PUT',
        p_source_type    => 'plsql/block',
        p_source         => q'[
DECLARE
    l_user_id       NUMBER;
    l_body          CLOB;
    l_doc_ids_str   VARCHAR2(4000);
    l_arr_count     NUMBER;
    l_temp          VARCHAR2(100);
BEGIN
    l_user_id := TO_NUMBER(:"X-User-Id");

    IF l_user_id IS NULL THEN
        OWA_UTIL.STATUS_LINE(401, 'Unauthorized');
        APEX_JSON.OPEN_OBJECT;
        APEX_JSON.WRITE('error', 'X-User-Id header is required');
        APEX_JSON.CLOSE_OBJECT;
        RETURN;
    END IF;

    -- Parse JSON request body
    l_body := :body_text;
    APEX_JSON.PARSE(l_body);

    -- Support both formats:
    -- 1) { "document_ids": "1,2,3" }  (comma-separated string)
    -- 2) { "document_ids": [1, 2, 3] } (JSON array)
    l_doc_ids_str := APEX_JSON.GET_VARCHAR2(p_path => 'document_ids');

    IF l_doc_ids_str IS NULL THEN
        -- Try as array
        l_arr_count := APEX_JSON.GET_COUNT(p_path => 'document_ids');
        IF l_arr_count IS NOT NULL AND l_arr_count > 0 THEN
            FOR i IN 1 .. l_arr_count LOOP
                l_temp := APEX_JSON.GET_VARCHAR2(p_path => 'document_ids[%d]', p0 => i);
                IF l_doc_ids_str IS NULL THEN
                    l_doc_ids_str := l_temp;
                ELSE
                    l_doc_ids_str := l_doc_ids_str || ',' || l_temp;
                END IF;
            END LOOP;
        ELSE
            -- No document_ids provided → unlink all
            l_doc_ids_str := '';
        END IF;
    END IF;

    -- Call the package procedure to reconcile links
    PKG_MCR_DOCS.update_task_links(
        p_user_id      => l_user_id,
        p_task_id      => TO_NUMBER(:task_id),
        p_document_ids => l_doc_ids_str
    );

    -- Return success
    OWA_UTIL.STATUS_LINE(200, 'OK');
    APEX_JSON.OPEN_OBJECT;
    APEX_JSON.WRITE('status', 'updated');
    APEX_JSON.WRITE('message', 'Task document links updated successfully');
    APEX_JSON.CLOSE_OBJECT;
END;
]',
        p_comments       => 'PUT handler - reconciles document-task links for the specified task'
    );

    COMMIT;
END;
/
