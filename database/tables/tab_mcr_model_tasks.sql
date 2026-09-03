-- TAB_MCR_MODEL_TASKS table
-- Individual tasks within a Model template, defining the reusable task list structure.
-- Tasks are copied into new MCRs when a Model is selected during MCR creation.
-- Spec reference: Backlog item 9

CREATE TABLE tab_mcr_model_tasks (
    model_task_id          NUMBER GENERATED ALWAYS AS IDENTITY
                           CONSTRAINT con_mcr_model_tasks_pk PRIMARY KEY,
    model_id               NUMBER NOT NULL
                           CONSTRAINT con_mcr_model_tasks_model_fk
                           REFERENCES tab_mcr_models(model_id) ON DELETE CASCADE,
    task_seq               NUMBER NOT NULL,
    title                  VARCHAR2(500) NOT NULL,
    description            VARCHAR2(4000),
    owner_dept_id          NUMBER,
    implementor_id         NUMBER,
    implementor_type       VARCHAR2(20)
                           CONSTRAINT con_mcr_model_tasks_impl_chk
                           CHECK (implementor_type IN ('USER', 'DEPARTMENT', 'TEAM')),
    benefits               VARCHAR2(4000),
    sub_actions            CLOB,
    backout_plan           CLOB,
    estimated_duration_mins NUMBER,
    soft_dep_seqs          VARCHAR2(1000),
    hard_dep_seqs          VARCHAR2(1000)
);

COMMENT ON TABLE tab_mcr_model_tasks IS 'Individual tasks within a Model template, defining the task list structure for reuse';
COMMENT ON COLUMN tab_mcr_model_tasks.model_task_id IS 'Surrogate primary key (identity column)';
COMMENT ON COLUMN tab_mcr_model_tasks.model_id IS 'Foreign key to the parent model in TAB_MCR_MODELS';
COMMENT ON COLUMN tab_mcr_model_tasks.task_seq IS 'Sequential task number within the model';
COMMENT ON COLUMN tab_mcr_model_tasks.title IS 'Short descriptive title for the model task';
COMMENT ON COLUMN tab_mcr_model_tasks.description IS 'Detailed description of the task work';
COMMENT ON COLUMN tab_mcr_model_tasks.owner_dept_id IS 'Department ID of the owning team';
COMMENT ON COLUMN tab_mcr_model_tasks.implementor_id IS 'ID of the implementor (user, department, or team depending on implementor_type)';
COMMENT ON COLUMN tab_mcr_model_tasks.implementor_type IS 'Type of implementor: USER, DEPARTMENT, or TEAM';
COMMENT ON COLUMN tab_mcr_model_tasks.benefits IS 'Description of the benefits this task delivers';
COMMENT ON COLUMN tab_mcr_model_tasks.sub_actions IS 'JSON or text list of sub-actions/steps for this task';
COMMENT ON COLUMN tab_mcr_model_tasks.backout_plan IS 'Backout/rollback plan if the task fails';
COMMENT ON COLUMN tab_mcr_model_tasks.estimated_duration_mins IS 'Estimated duration of the task in minutes';
COMMENT ON COLUMN tab_mcr_model_tasks.soft_dep_seqs IS 'Comma-separated task_seq values for soft (any-status) dependencies';
COMMENT ON COLUMN tab_mcr_model_tasks.hard_dep_seqs IS 'Comma-separated task_seq values for hard (must-succeed) dependencies';

-- Performance index: supports task list queries by parent model
CREATE INDEX ind_mcr_model_tasks_model_id ON tab_mcr_model_tasks(model_id);
