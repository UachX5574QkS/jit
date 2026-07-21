-- TAB_MCR_DEPENDENCIES table
-- Stores task dependency relationships within an MCR, supporting both hard and soft dependency types.
-- Requirement 4.4, 15.1: Record task dependencies with self-reference prevention.

CREATE TABLE tab_mcr_dependencies (
    dependency_id        NUMBER GENERATED ALWAYS AS IDENTITY
                         CONSTRAINT con_mcr_deps_pk PRIMARY KEY,
    task_id              NUMBER NOT NULL
                         CONSTRAINT con_mcr_deps_task_fk
                         REFERENCES tab_mcr_tasks(task_id),
    depends_on_task_id   NUMBER NOT NULL
                         CONSTRAINT con_mcr_deps_depends_fk
                         REFERENCES tab_mcr_tasks(task_id),
    dependency_type      VARCHAR2(10) NOT NULL
                         CONSTRAINT con_mcr_deps_type_chk
                         CHECK (dependency_type IN ('HARD', 'SOFT')),
    CONSTRAINT con_mcr_deps_no_self_ref CHECK (task_id != depends_on_task_id)
);

COMMENT ON TABLE tab_mcr_dependencies IS 'Task dependency relationships within an MCR, linking dependent tasks to their prerequisites';
COMMENT ON COLUMN tab_mcr_dependencies.dependency_id IS 'Surrogate primary key (identity column)';
COMMENT ON COLUMN tab_mcr_dependencies.task_id IS 'The dependent task that requires another task to complete first';
COMMENT ON COLUMN tab_mcr_dependencies.depends_on_task_id IS 'The prerequisite task that must complete before the dependent task can proceed';
COMMENT ON COLUMN tab_mcr_dependencies.dependency_type IS 'Type of dependency: HARD (prerequisite must succeed) or SOFT (prerequisite must reach terminal state)';
