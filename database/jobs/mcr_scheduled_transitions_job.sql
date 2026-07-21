-- MCR_SCHEDULED_TRANSITIONS_JOB
-- Creates a DBMS_SCHEDULER job that runs pkg_mcr_lifecycle.run_scheduled_transitions
-- every 5 minutes to automate MCR lifecycle transitions.
--
-- Transitions handled:
--   Locked -> Active          (current date within MCR execution window)
--   Active -> Complete        (all tasks Complete)
--   Active -> Partial_Complete (all tasks terminal, not all Complete)
--   Active -> DNF             (end date passed, tasks not all terminal)
--
-- Requirements 10.1, 10.2, 10.3, 10.4, 13.1

BEGIN
    DBMS_SCHEDULER.CREATE_JOB(
        job_name        => 'JOB_MCR_TRANSITIONS',
        job_type        => 'PLSQL_BLOCK',
        job_action      => 'BEGIN pkg_mcr_lifecycle.run_scheduled_transitions; END;',
        start_date      => SYSTIMESTAMP,
        repeat_interval => 'FREQ=MINUTELY;INTERVAL=5',
        enabled         => TRUE,
        comments        => 'MCR Manager: Automated lifecycle transitions (Locked->Active, Active->Complete/Partial_Complete/DNF)'
    );
END;
/
