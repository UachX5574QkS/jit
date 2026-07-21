-- TAB_MCR_ACTIONS table
-- Stores discrete action steps within an MCR_Task, ordered by ordinal position for sequential execution.
-- Requirement 5.3, 15.1: Task actions with identity PK, ordinal ordering, status tracking, and naming convention.

CREATE TABLE tab_mcr_actions (
    action_id              NUMBER GENERATED ALWAYS AS IDENTITY
                           CONSTRAINT con_mcr_actions_pk PRIMARY KEY,
    task_id                NUMBER         NOT NULL
                           CONSTRAINT con_mcr_actions_task_fk
                           REFERENCES tab_mcr_tasks(task_id),
    ordinal_position       NUMBER         NOT NULL,
    title                  VARCHAR2(500)  NOT NULL,
    description            VARCHAR2(4000),
    action_status          VARCHAR2(20)   DEFAULT 'Not_Started' NOT NULL
                           CONSTRAINT con_mcr_actions_status_chk
                           CHECK (action_status IN (
                               'Not_Started','Complete','Failed_Stop',
                               'Failed_Continue','Skipped'
                           )),
    updated_at             TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

COMMENT ON TABLE tab_mcr_actions IS 'Discrete action steps within an MCR task, ordered by ordinal position for sequential execution';
COMMENT ON COLUMN tab_mcr_actions.action_id IS 'Surrogate primary key (identity column)';
COMMENT ON COLUMN tab_mcr_actions.task_id IS 'Foreign key to tab_mcr_tasks identifying the parent task';
COMMENT ON COLUMN tab_mcr_actions.ordinal_position IS 'Execution order of the action within the parent task (1-based, contiguous)';
COMMENT ON COLUMN tab_mcr_actions.title IS 'Short title describing the action step';
COMMENT ON COLUMN tab_mcr_actions.description IS 'Detailed description of what the action entails';
COMMENT ON COLUMN tab_mcr_actions.action_status IS 'Current completion status: Not_Started, Complete, Failed_Stop, Failed_Continue, Skipped';
COMMENT ON COLUMN tab_mcr_actions.updated_at IS 'Timestamp of the last status change or modification';
