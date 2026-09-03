-- TAB_MCR_MODELS table
-- Reusable task list templates (Models) that can be applied when creating new MCRs.
-- Spec reference: Backlog item 9

CREATE TABLE tab_mcr_models (
    model_id     NUMBER GENERATED ALWAYS AS IDENTITY
                 CONSTRAINT con_mcr_models_pk PRIMARY KEY,
    model_name   VARCHAR2(255) NOT NULL
                 CONSTRAINT con_mcr_models_name_uk UNIQUE,
    description  VARCHAR2(2000),
    created_by   NUMBER
                 CONSTRAINT con_mcr_models_created_by_fk
                 REFERENCES tab_idcs_users(user_id),
    created_at   TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

COMMENT ON TABLE tab_mcr_models IS 'Reusable task list templates (Models) that can be applied when creating new MCRs';
COMMENT ON COLUMN tab_mcr_models.model_id IS 'Surrogate primary key (identity column)';
COMMENT ON COLUMN tab_mcr_models.model_name IS 'Unique name for the model template';
COMMENT ON COLUMN tab_mcr_models.description IS 'Description of what this model template covers';
COMMENT ON COLUMN tab_mcr_models.created_by IS 'User ID of the model creator (FK to tab_idcs_users)';
COMMENT ON COLUMN tab_mcr_models.created_at IS 'Record creation timestamp';
