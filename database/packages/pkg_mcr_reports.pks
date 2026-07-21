CREATE OR REPLACE PACKAGE pkg_mcr_reports AS
    /*
    ** PKG_MCR_REPORTS
    ** Report generation and distribution for MCR Manager. Provides JSON-based
    ** MCR reports including progress statistics, RACI details, and AI-summarised
    ** benefits text. Supports email distribution to Informed RACI users.
    **
    ** Requirements 11.1, 11.2, 11.3, 11.4, 11.5: MCR report generation with
    ** AI benefits summary, progress charts data, and email distribution.
    */

    ----------------------------------------------------------------------------
    -- generate_report
    --
    -- Builds a comprehensive MCR report as JSON output via APEX_JSON. Includes
    -- MCR high-level details (mcr_number, owner, description, dates, status),
    -- RACI assignments, progress statistics, and individual task statuses.
    --
    -- Parameters:
    --   p_mcr_id - Numeric ID of the MCR to report on
    --
    -- Output:
    --   JSON written to HTP buffer via APEX_JSON containing:
    --     - mcr: { mcr_number, owner, description, start_date, end_date, status }
    --     - raci: [ { user_id, display_name, email, raci_role } ]
    --     - progress: { total, complete, failed, cancelled, blocked, ready, pct_complete }
    --     - tasks: [ { task_id, task_seq, title, task_status, jira_reference, benefits } ]
    --     - benefits_summary: CLOB (AI-generated summary)
    ----------------------------------------------------------------------------
    PROCEDURE generate_report(
        p_mcr_id IN NUMBER
    );

    ----------------------------------------------------------------------------
    -- summarise_benefits
    --
    -- Concatenates all non-null benefits text from MCR tasks and uses Oracle
    -- Database AI tools (DBMS_CLOUD_AI.GENERATE) to produce a summary. Falls
    -- back to returning the concatenated benefits if AI is unavailable.
    --
    -- Parameters:
    --   p_mcr_id - Numeric ID of the MCR whose task benefits to summarise
    --
    -- Returns:
    --   CLOB containing the AI-generated summary or raw concatenated benefits
    ----------------------------------------------------------------------------
    FUNCTION summarise_benefits(
        p_mcr_id IN NUMBER
    ) RETURN CLOB;

    ----------------------------------------------------------------------------
    -- get_progress_stats
    --
    -- Returns task counts grouped by status for a given MCR as JSON output
    -- via APEX_JSON.
    --
    -- Parameters:
    --   p_mcr_id - Numeric ID of the MCR
    --
    -- Output:
    --   JSON written to HTP buffer via APEX_JSON containing:
    --     - total: total task count
    --     - complete: count of Complete tasks
    --     - failed: count of Failed tasks
    --     - cancelled: count of Cancelled tasks
    --     - blocked: count of Blocked tasks
    --     - ready: count of Ready tasks
    --     - pct_complete: percentage of tasks Complete (rounded)
    ----------------------------------------------------------------------------
    PROCEDURE get_progress_stats(
        p_mcr_id IN NUMBER
    );

    ----------------------------------------------------------------------------
    -- send_report_email
    --
    -- Resolves email addresses for all users assigned the Informed role in the
    -- MCR's RACI, then composes and sends an email containing the MCR report
    -- to each recipient using APEX_MAIL.
    --
    -- Parameters:
    --   p_mcr_id   - Numeric ID of the MCR to report on
    --   p_user_id  - Numeric ID of the user initiating the send (for audit)
    --
    -- Behaviour:
    --   - Queries tab_mcr_raci for Informed users, joins tab_idcs_users for emails
    --   - Composes email with MCR summary and progress stats
    --   - Sends via APEX_MAIL.SEND for each recipient
    --   - Wraps in exception handler for graceful failure (logs but does not raise)
    ----------------------------------------------------------------------------
    PROCEDURE send_report_email(
        p_mcr_id   IN NUMBER,
        p_user_id  IN NUMBER
    );

END pkg_mcr_reports;
/
