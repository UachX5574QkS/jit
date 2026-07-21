CREATE OR REPLACE PACKAGE pkg_mcr_docs AS
    /*
    ** PKG_MCR_DOCS
    ** Document management operations for MCR Manager. Handles document upload,
    ** storage, and task-document linking. Document linking is ALWAYS allowed
    ** regardless of MCR status (Requirement 10.6).
    **
    ** Requirements 6.1–6.7, 10.6, 13.1: Document upload with title validation,
    ** task-document link management, audit trail recording.
    */

    -- Custom exceptions
    e_invalid_title EXCEPTION;
    PRAGMA EXCEPTION_INIT(e_invalid_title, -20020);

    ----------------------------------------------------------------------------
    -- upload_document
    --
    -- Validates the document title (trimmed length 1–255 characters), stores
    -- the BLOB content and metadata into tab_mcr_documents, and records the
    -- upload in the audit log.
    --
    -- Parameters:
    --   p_user_id      - Numeric ID of the acting user
    --   p_mcr_id       - MCR to associate the document with
    --   p_title        - User-provided document title (1–255 chars after trim)
    --   p_content      - Binary content of the uploaded file
    --   p_content_type - MIME type of the uploaded file
    --
    -- Raises:
    --   e_invalid_title (-20020) when title is empty, whitespace-only, or
    --                   exceeds 255 characters after trimming
    ----------------------------------------------------------------------------
    PROCEDURE upload_document(
        p_user_id      IN NUMBER,
        p_mcr_id       IN NUMBER,
        p_title        IN VARCHAR2,
        p_content      IN BLOB,
        p_content_type IN VARCHAR2
    );

    ----------------------------------------------------------------------------
    -- link_document
    --
    -- Creates a link between a document and a task in tab_mcr_doc_links.
    -- Document linking is always allowed regardless of MCR status (Req 10.6).
    -- Records the link creation in the audit log.
    --
    -- Parameters:
    --   p_user_id     - Numeric ID of the acting user
    --   p_task_id     - Task to link the document to
    --   p_document_id - Document to link
    ----------------------------------------------------------------------------
    PROCEDURE link_document(
        p_user_id     IN NUMBER,
        p_task_id     IN NUMBER,
        p_document_id IN NUMBER
    );

    ----------------------------------------------------------------------------
    -- unlink_document
    --
    -- Removes the link between a document and a task from tab_mcr_doc_links.
    -- Document unlinking is always allowed regardless of MCR status (Req 10.6).
    -- Records the unlink in the audit log.
    --
    -- Parameters:
    --   p_user_id     - Numeric ID of the acting user
    --   p_task_id     - Task to unlink the document from
    --   p_document_id - Document to unlink
    ----------------------------------------------------------------------------
    PROCEDURE unlink_document(
        p_user_id     IN NUMBER,
        p_task_id     IN NUMBER,
        p_document_id IN NUMBER
    );

    ----------------------------------------------------------------------------
    -- update_task_links
    --
    -- Reconciles the set of documents linked to a task with the provided list.
    -- Adds links for document IDs in the set that are not currently linked,
    -- removes links for document IDs currently linked but not in the set.
    -- Records each add/remove in the audit log.
    --
    -- Parameters:
    --   p_user_id      - Numeric ID of the acting user
    --   p_task_id      - Task to reconcile links for
    --   p_document_ids - Comma-separated list of document IDs representing
    --                    the desired final link state (empty string = unlink all)
    ----------------------------------------------------------------------------
    PROCEDURE update_task_links(
        p_user_id      IN NUMBER,
        p_task_id      IN NUMBER,
        p_document_ids IN VARCHAR2
    );

    ----------------------------------------------------------------------------
    -- get_mcr_documents
    --
    -- Returns all documents uploaded to a given MCR as a SYS_REFCURSOR.
    --
    -- Parameters:
    --   p_mcr_id - MCR to retrieve documents for
    --
    -- Returns:
    --   SYS_REFCURSOR with document_id, mcr_id, title, content_type,
    --   uploaded_by_user_id, uploaded_at
    ----------------------------------------------------------------------------
    FUNCTION get_mcr_documents(
        p_mcr_id IN NUMBER
    ) RETURN SYS_REFCURSOR;

    ----------------------------------------------------------------------------
    -- get_task_documents
    --
    -- Returns all documents linked to a specific task as a SYS_REFCURSOR.
    --
    -- Parameters:
    --   p_task_id - Task to retrieve linked documents for
    --
    -- Returns:
    --   SYS_REFCURSOR with document_id, title, content_type,
    --   uploaded_by_user_id, uploaded_at
    ----------------------------------------------------------------------------
    FUNCTION get_task_documents(
        p_task_id IN NUMBER
    ) RETURN SYS_REFCURSOR;

END pkg_mcr_docs;
/
