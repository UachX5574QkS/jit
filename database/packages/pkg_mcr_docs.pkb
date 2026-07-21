CREATE OR REPLACE PACKAGE BODY pkg_mcr_docs AS
    /*
    ** PKG_MCR_DOCS (Body)
    ** Document management operations for MCR Manager. Handles document upload,
    ** storage, and task-document linking. Document linking is ALWAYS allowed
    ** regardless of MCR status (Requirement 10.6).
    */

    ----------------------------------------------------------------------------
    -- upload_document
    ----------------------------------------------------------------------------
    PROCEDURE upload_document(
        p_user_id      IN NUMBER,
        p_mcr_id       IN NUMBER,
        p_title        IN VARCHAR2,
        p_content      IN BLOB,
        p_content_type IN VARCHAR2
    ) IS
        l_trimmed_title VARCHAR2(255);
        l_document_id   NUMBER;
    BEGIN
        -- Validate title: trim and check length 1–255
        l_trimmed_title := TRIM(p_title);

        IF l_trimmed_title IS NULL OR LENGTH(l_trimmed_title) = 0 THEN
            RAISE_APPLICATION_ERROR(-20020,
                'Document title is invalid: must be between 1 and 255 characters (cannot be empty or whitespace-only)');
        END IF;

        IF LENGTH(l_trimmed_title) > 255 THEN
            RAISE_APPLICATION_ERROR(-20020,
                'Document title is invalid: must be between 1 and 255 characters (current length: '
                || LENGTH(l_trimmed_title) || ')');
        END IF;

        -- Insert document record
        INSERT INTO tab_mcr_documents (
            mcr_id,
            title,
            file_content,
            content_type,
            uploaded_by_user_id,
            uploaded_at
        ) VALUES (
            p_mcr_id,
            l_trimmed_title,
            p_content,
            p_content_type,
            p_user_id,
            SYSTIMESTAMP
        )
        RETURNING document_id INTO l_document_id;

        -- Record audit entry
        pkg_mcr_audit.log_change(
            p_user_id     => p_user_id,
            p_operation   => 'CREATE',
            p_object_type => 'DOCUMENT',
            p_object_id   => l_document_id,
            p_old_values  => NULL,
            p_new_values  => '{"mcr_id":' || p_mcr_id
                          || ',"title":"' || l_trimmed_title
                          || '","content_type":"' || p_content_type || '"}'
        );
    END upload_document;

    ----------------------------------------------------------------------------
    -- link_document
    ----------------------------------------------------------------------------
    PROCEDURE link_document(
        p_user_id     IN NUMBER,
        p_task_id     IN NUMBER,
        p_document_id IN NUMBER
    ) IS
        l_link_id NUMBER;
    BEGIN
        -- Insert link (unique constraint prevents duplicates)
        INSERT INTO tab_mcr_doc_links (
            task_id,
            document_id
        ) VALUES (
            p_task_id,
            p_document_id
        )
        RETURNING link_id INTO l_link_id;

        -- Record audit entry
        pkg_mcr_audit.log_change(
            p_user_id     => p_user_id,
            p_operation   => 'CREATE',
            p_object_type => 'DOC_LINK',
            p_object_id   => l_link_id,
            p_old_values  => NULL,
            p_new_values  => '{"task_id":' || p_task_id
                          || ',"document_id":' || p_document_id || '}'
        );
    END link_document;

    ----------------------------------------------------------------------------
    -- unlink_document
    ----------------------------------------------------------------------------
    PROCEDURE unlink_document(
        p_user_id     IN NUMBER,
        p_task_id     IN NUMBER,
        p_document_id IN NUMBER
    ) IS
        l_link_id NUMBER;
    BEGIN
        -- Find the link_id before deleting (for audit purposes)
        SELECT link_id
          INTO l_link_id
          FROM tab_mcr_doc_links
         WHERE task_id     = p_task_id
           AND document_id = p_document_id;

        -- Remove the link
        DELETE FROM tab_mcr_doc_links
         WHERE link_id = l_link_id;

        -- Record audit entry
        pkg_mcr_audit.log_change(
            p_user_id     => p_user_id,
            p_operation   => 'DELETE',
            p_object_type => 'DOC_LINK',
            p_object_id   => l_link_id,
            p_old_values  => '{"task_id":' || p_task_id
                          || ',"document_id":' || p_document_id || '}',
            p_new_values  => NULL
        );
    END unlink_document;

    ----------------------------------------------------------------------------
    -- update_task_links
    ----------------------------------------------------------------------------
    PROCEDURE update_task_links(
        p_user_id      IN NUMBER,
        p_task_id      IN NUMBER,
        p_document_ids IN VARCHAR2
    ) IS
        l_doc_id      NUMBER;
        l_link_id     NUMBER;
        l_pos         PLS_INTEGER;
        l_start       PLS_INTEGER;
        l_ids_str     VARCHAR2(4000);
        l_token       VARCHAR2(100);

        -- Type for collecting desired document IDs
        TYPE t_num_tab IS TABLE OF NUMBER INDEX BY PLS_INTEGER;
        l_desired_ids t_num_tab;
        l_idx         PLS_INTEGER := 0;

        -- Cursor for existing links
        CURSOR c_existing IS
            SELECT link_id, document_id
              FROM tab_mcr_doc_links
             WHERE task_id = p_task_id;
    BEGIN
        -- Parse comma-separated document IDs into collection
        l_ids_str := TRIM(p_document_ids);

        IF l_ids_str IS NOT NULL AND LENGTH(l_ids_str) > 0 THEN
            l_start := 1;
            LOOP
                l_pos := INSTR(l_ids_str, ',', l_start);
                IF l_pos = 0 THEN
                    l_token := TRIM(SUBSTR(l_ids_str, l_start));
                ELSE
                    l_token := TRIM(SUBSTR(l_ids_str, l_start, l_pos - l_start));
                END IF;

                IF l_token IS NOT NULL AND LENGTH(l_token) > 0 THEN
                    l_idx := l_idx + 1;
                    l_desired_ids(l_idx) := TO_NUMBER(l_token);
                END IF;

                EXIT WHEN l_pos = 0;
                l_start := l_pos + 1;
            END LOOP;
        END IF;

        -- Remove existing links that are NOT in the desired set
        FOR rec IN c_existing LOOP
            DECLARE
                l_found BOOLEAN := FALSE;
            BEGIN
                FOR i IN 1 .. l_idx LOOP
                    IF l_desired_ids(i) = rec.document_id THEN
                        l_found := TRUE;
                        EXIT;
                    END IF;
                END LOOP;

                IF NOT l_found THEN
                    DELETE FROM tab_mcr_doc_links
                     WHERE link_id = rec.link_id;

                    pkg_mcr_audit.log_change(
                        p_user_id     => p_user_id,
                        p_operation   => 'DELETE',
                        p_object_type => 'DOC_LINK',
                        p_object_id   => rec.link_id,
                        p_old_values  => '{"task_id":' || p_task_id
                                      || ',"document_id":' || rec.document_id || '}',
                        p_new_values  => NULL
                    );
                END IF;
            END;
        END LOOP;

        -- Add links for desired IDs that are not currently linked
        FOR i IN 1 .. l_idx LOOP
            DECLARE
                l_exists NUMBER;
            BEGIN
                SELECT COUNT(*)
                  INTO l_exists
                  FROM tab_mcr_doc_links
                 WHERE task_id     = p_task_id
                   AND document_id = l_desired_ids(i);

                IF l_exists = 0 THEN
                    INSERT INTO tab_mcr_doc_links (
                        task_id,
                        document_id
                    ) VALUES (
                        p_task_id,
                        l_desired_ids(i)
                    )
                    RETURNING link_id INTO l_link_id;

                    pkg_mcr_audit.log_change(
                        p_user_id     => p_user_id,
                        p_operation   => 'CREATE',
                        p_object_type => 'DOC_LINK',
                        p_object_id   => l_link_id,
                        p_old_values  => NULL,
                        p_new_values  => '{"task_id":' || p_task_id
                                      || ',"document_id":' || l_desired_ids(i) || '}'
                    );
                END IF;
            END;
        END LOOP;
    END update_task_links;

    ----------------------------------------------------------------------------
    -- get_mcr_documents
    ----------------------------------------------------------------------------
    FUNCTION get_mcr_documents(
        p_mcr_id IN NUMBER
    ) RETURN SYS_REFCURSOR IS
        l_cursor SYS_REFCURSOR;
    BEGIN
        OPEN l_cursor FOR
            SELECT document_id,
                   mcr_id,
                   title,
                   content_type,
                   uploaded_by_user_id,
                   uploaded_at
              FROM tab_mcr_documents
             WHERE mcr_id = p_mcr_id
             ORDER BY uploaded_at DESC;

        RETURN l_cursor;
    END get_mcr_documents;

    ----------------------------------------------------------------------------
    -- get_task_documents
    ----------------------------------------------------------------------------
    FUNCTION get_task_documents(
        p_task_id IN NUMBER
    ) RETURN SYS_REFCURSOR IS
        l_cursor SYS_REFCURSOR;
    BEGIN
        OPEN l_cursor FOR
            SELECT d.document_id,
                   d.title,
                   d.content_type,
                   d.uploaded_by_user_id,
                   d.uploaded_at
              FROM tab_mcr_documents d
              JOIN tab_mcr_doc_links l ON l.document_id = d.document_id
             WHERE l.task_id = p_task_id
             ORDER BY d.uploaded_at DESC;

        RETURN l_cursor;
    END get_task_documents;

END pkg_mcr_docs;
/
