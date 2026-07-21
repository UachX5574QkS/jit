-- TAB_MCR_DOCUMENTS table
-- Stores documents uploaded against a Managed Change Request (title, BLOB content, and metadata).
-- Requirement 6.5, 6.6, 15.1: Document storage with identity PK and naming conventions.

CREATE TABLE tab_mcr_documents (
    document_id          NUMBER GENERATED ALWAYS AS IDENTITY
                         CONSTRAINT con_mcr_docs_pk PRIMARY KEY,
    mcr_id               NUMBER         NOT NULL
                         CONSTRAINT con_mcr_docs_mcr_fk
                         REFERENCES tab_mcr_requests(mcr_id),
    title                VARCHAR2(255)  NOT NULL,
    file_content         BLOB,
    content_type         VARCHAR2(200),
    uploaded_by_user_id  NUMBER
                         CONSTRAINT con_mcr_docs_user_fk
                         REFERENCES tab_idcs_users(user_id),
    uploaded_at          TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

COMMENT ON TABLE tab_mcr_documents IS 'Documents uploaded against a Managed Change Request with file content and metadata';
COMMENT ON COLUMN tab_mcr_documents.document_id IS 'Surrogate primary key (identity column)';
COMMENT ON COLUMN tab_mcr_documents.mcr_id IS 'Foreign key to tab_mcr_requests identifying the parent MCR';
COMMENT ON COLUMN tab_mcr_documents.title IS 'User-provided document title (1–255 characters)';
COMMENT ON COLUMN tab_mcr_documents.file_content IS 'Binary content of the uploaded file';
COMMENT ON COLUMN tab_mcr_documents.content_type IS 'MIME type of the uploaded file (e.g., application/pdf)';
COMMENT ON COLUMN tab_mcr_documents.uploaded_by_user_id IS 'Foreign key to tab_idcs_users identifying the uploading user';
COMMENT ON COLUMN tab_mcr_documents.uploaded_at IS 'Timestamp when the document was uploaded';


-- TAB_MCR_DOC_LINKS table
-- Associates documents with individual MCR tasks (many-to-many linking table).
-- Requirement 6.5, 6.6, 15.1: Document-task linking with unique constraint.

CREATE TABLE tab_mcr_doc_links (
    link_id              NUMBER GENERATED ALWAYS AS IDENTITY
                         CONSTRAINT con_mcr_doc_links_pk PRIMARY KEY,
    task_id              NUMBER         NOT NULL
                         CONSTRAINT con_mcr_doc_links_task_fk
                         REFERENCES tab_mcr_tasks(task_id),
    document_id          NUMBER         NOT NULL
                         CONSTRAINT con_mcr_doc_links_doc_fk
                         REFERENCES tab_mcr_documents(document_id),
    CONSTRAINT con_mcr_doc_links_uk UNIQUE (task_id, document_id)
);

COMMENT ON TABLE tab_mcr_doc_links IS 'Many-to-many linking table associating documents with MCR tasks';
COMMENT ON COLUMN tab_mcr_doc_links.link_id IS 'Surrogate primary key (identity column)';
COMMENT ON COLUMN tab_mcr_doc_links.task_id IS 'Foreign key to tab_mcr_tasks identifying the linked task';
COMMENT ON COLUMN tab_mcr_doc_links.document_id IS 'Foreign key to tab_mcr_documents identifying the linked document';
