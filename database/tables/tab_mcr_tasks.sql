-- TAB_MCR_TASKS table
-- Stores individual tasks within a Managed Change Request (MCR), including ownership,
-- scheduling, dependencies metadata, and lifecycle status.
-- Requirements 4.1, 4.7, 15.1: MCR task management with implementor type support and naming conventions.

CREATE TABLE tab_mcr_tasks (
    task_id                  NUMBER GENERATED ALWAYS AS IDENTITY
                             CONSTRAINT con_mcr_tasks_pk PRIMARY KEY,
    mcr_id                   NUMBER NOT NULL
                             CONSTRAINT con_mcr_tasks_mcr_fk
                             REFERENCES tab_mcr_requests(mcr_id),
    task_seq                 NUMBER NOT NULL,
    title                    VARCHAR2(500) NOT NULL,
    description              VARCHAR2(4000),
    jira_reference           VARCHAR2(100),
    start_time               TIMESTAMP WITH TIME ZONE,
    estimated_duration_mins  NUMBER,
    owner_dept_id            NUMBER,
    implementor_id           NUMBER,
    implementor_type         VARCHAR2(20)
                             CONSTRAINT con_mcr_tasks_impl_type_chk
                             CHECK (implementor_type IN ('USER', 'DEPARTMENT')),
    task_status              VARCHAR2(20) DEFAULT 'Ready' NOT NULL
                             CONSTRAINT con_mcr_tasks_status_chk
                             CHECK (task_status IN ('Blocked', 'Ready', 'Complete', 'Cancelled', 'Failed')),
    benefits                 VARCHAR2(4000),
    created_by_user_id       NUMBER
                             CONSTRAINT con_mcr_tasks_created_by_fk
                             REFERENCES tab_idcs_users(user_id),
    created_at               TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
    updated_at               TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

COMMENT ON TABLE tab_mcr_tasks IS 'Individual tasks within a Managed Change Request, each with ownership, scheduling, and lifecycle status';
COMMENT ON COLUMN tab_mcr_tasks.task_id IS 'Surrogate primary key (identity column)';
COMMENT ON COLUMN tab_mcr_tasks.mcr_id IS 'Foreign key to the parent MCR in TAB_MCR_REQUESTS';
COMMENT ON COLUMN tab_mcr_tasks.task_seq IS 'Sequential task number within the MCR (assigned on creation)';
COMMENT ON COLUMN tab_mcr_tasks.title IS 'Short descriptive title for the task';
COMMENT ON COLUMN tab_mcr_tasks.description IS 'Detailed description of the task work to be performed';
COMMENT ON COLUMN tab_mcr_tasks.jira_reference IS 'External Jira ticket reference for traceability';
COMMENT ON COLUMN tab_mcr_tasks.start_time IS 'Planned execution start time for the task';
COMMENT ON COLUMN tab_mcr_tasks.estimated_duration_mins IS 'Estimated duration of the task in minutes';
COMMENT ON COLUMN tab_mcr_tasks.owner_dept_id IS 'Department ID of the owning team responsible for the task';
COMMENT ON COLUMN tab_mcr_tasks.implementor_id IS 'ID of the implementor (user ID or department ID depending on implementor_type)';
COMMENT ON COLUMN tab_mcr_tasks.implementor_type IS 'Type of implementor: USER (individual) or DEPARTMENT (team)';
COMMENT ON COLUMN tab_mcr_tasks.task_status IS 'Current lifecycle status: Blocked, Ready, Complete, Cancelled, or Failed';
COMMENT ON COLUMN tab_mcr_tasks.benefits IS 'Description of the benefits this task delivers';
COMMENT ON COLUMN tab_mcr_tasks.created_by_user_id IS 'User ID of the task author (foreign key to tab_idcs_users)';
COMMENT ON COLUMN tab_mcr_tasks.created_at IS 'Record creation timestamp';
COMMENT ON COLUMN tab_mcr_tasks.updated_at IS 'Last modification timestamp';
