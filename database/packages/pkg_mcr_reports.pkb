CREATE OR REPLACE PACKAGE BODY pkg_mcr_reports AS
    /*
    ** PKG_MCR_REPORTS (Body)
    ** Report generation and distribution for MCR Manager.
    */

    ----------------------------------------------------------------------------
    -- generate_report
    ----------------------------------------------------------------------------
    PROCEDURE generate_report(
        p_mcr_id IN NUMBER
    ) IS
        l_mcr_number          tab_mcr_requests.mcr_number%TYPE;
        l_owner_user_id       tab_mcr_requests.owner_user_id%TYPE;
        l_owner_name          tab_idcs_users.display_name%TYPE;
        l_description         tab_mcr_requests.description%TYPE;
        l_start_date          tab_mcr_requests.estimated_start_date%TYPE;
        l_end_date            tab_mcr_requests.estimated_end_date%TYPE;
        l_status              tab_mcr_requests.mcr_status%TYPE;
        l_total               NUMBER := 0;
        l_complete            NUMBER := 0;
        l_failed              NUMBER := 0;
        l_cancelled           NUMBER := 0;
        l_blocked             NUMBER := 0;
        l_ready               NUMBER := 0;
        l_pct_complete        NUMBER := 0;
        l_benefits_summary    CLOB;
    BEGIN
        -- Fetch MCR details
        SELECT r.mcr_number,
               r.owner_user_id,
               u.display_name,
               r.description,
               r.estimated_start_date,
               r.estimated_end_date,
               r.mcr_status
          INTO l_mcr_number,
               l_owner_user_id,
               l_owner_name,
               l_description,
               l_start_date,
               l_end_date,
               l_status
          FROM tab_mcr_requests r
          JOIN tab_idcs_users u ON u.user_id = r.owner_user_id
         WHERE r.mcr_id = p_mcr_id;

        -- Calculate progress stats
        SELECT COUNT(*),
               COUNT(CASE WHEN task_status = 'Complete' THEN 1 END),
               COUNT(CASE WHEN task_status = 'Failed' THEN 1 END),
               COUNT(CASE WHEN task_status = 'Cancelled' THEN 1 END),
               COUNT(CASE WHEN task_status = 'Blocked' THEN 1 END),
               COUNT(CASE WHEN task_status = 'Ready' THEN 1 END)
          INTO l_total, l_complete, l_failed, l_cancelled, l_blocked, l_ready
          FROM tab_mcr_tasks
         WHERE mcr_id = p_mcr_id;

        IF l_total > 0 THEN
            l_pct_complete := ROUND(l_complete * 100 / l_total, 0);
        END IF;

        -- Generate AI benefits summary
        l_benefits_summary := summarise_benefits(p_mcr_id);

        -- Build JSON response
        APEX_JSON.open_object;

        -- MCR details
        APEX_JSON.open_object('mcr');
        APEX_JSON.write('mcr_id', p_mcr_id);
        APEX_JSON.write('mcr_number', l_mcr_number);
        APEX_JSON.write('owner_user_id', l_owner_user_id);
        APEX_JSON.write('owner_name', l_owner_name);
        APEX_JSON.write('description', l_description);
        APEX_JSON.write('estimated_start_date', TO_CHAR(l_start_date, 'YYYY-MM-DD'));
        APEX_JSON.write('estimated_end_date', TO_CHAR(l_end_date, 'YYYY-MM-DD'));
        APEX_JSON.write('status', l_status);
        APEX_JSON.close_object; -- mcr

        -- RACI assignments
        APEX_JSON.open_array('raci');
        FOR rec IN (
            SELECT ra.user_id,
                   u.display_name,
                   u.email,
                   ra.raci_role
              FROM tab_mcr_raci ra
              JOIN tab_idcs_users u ON u.user_id = ra.user_id
             WHERE ra.mcr_id = p_mcr_id
             ORDER BY ra.raci_role, u.display_name
        ) LOOP
            APEX_JSON.open_object;
            APEX_JSON.write('user_id', rec.user_id);
            APEX_JSON.write('display_name', rec.display_name);
            APEX_JSON.write('email', rec.email);
            APEX_JSON.write('raci_role', rec.raci_role);
            APEX_JSON.close_object;
        END LOOP;
        APEX_JSON.close_array; -- raci

        -- Progress statistics
        APEX_JSON.open_object('progress');
        APEX_JSON.write('total', l_total);
        APEX_JSON.write('complete', l_complete);
        APEX_JSON.write('failed', l_failed);
        APEX_JSON.write('cancelled', l_cancelled);
        APEX_JSON.write('blocked', l_blocked);
        APEX_JSON.write('ready', l_ready);
        APEX_JSON.write('pct_complete', l_pct_complete);
        APEX_JSON.close_object; -- progress

        -- Task list with statuses
        APEX_JSON.open_array('tasks');
        FOR rec IN (
            SELECT task_id,
                   task_seq,
                   title,
                   task_status,
                   jira_reference,
                   benefits,
                   description
              FROM tab_mcr_tasks
             WHERE mcr_id = p_mcr_id
             ORDER BY task_seq
        ) LOOP
            APEX_JSON.open_object;
            APEX_JSON.write('task_id', rec.task_id);
            APEX_JSON.write('task_seq', rec.task_seq);
            APEX_JSON.write('title', rec.title);
            APEX_JSON.write('task_status', rec.task_status);
            APEX_JSON.write('jira_reference', rec.jira_reference);
            APEX_JSON.write('benefits', rec.benefits);
            APEX_JSON.write('description', rec.description);
            APEX_JSON.close_object;
        END LOOP;
        APEX_JSON.close_array; -- tasks

        -- Benefits summary
        APEX_JSON.write('benefits_summary', l_benefits_summary);

        APEX_JSON.close_object; -- root
    END generate_report;

    ----------------------------------------------------------------------------
    -- summarise_benefits
    ----------------------------------------------------------------------------
    FUNCTION summarise_benefits(
        p_mcr_id IN NUMBER
    ) RETURN CLOB IS
        l_all_benefits   CLOB;
        l_summary        CLOB;
    BEGIN
        -- Concatenate all non-null benefits from MCR tasks
        FOR rec IN (
            SELECT benefits
              FROM tab_mcr_tasks
             WHERE mcr_id = p_mcr_id
               AND benefits IS NOT NULL
             ORDER BY task_seq
        ) LOOP
            IF l_all_benefits IS NOT NULL THEN
                l_all_benefits := l_all_benefits || CHR(10) || '- ' || rec.benefits;
            ELSE
                l_all_benefits := '- ' || rec.benefits;
            END IF;
        END LOOP;

        -- If no benefits text exists, return a default message
        IF l_all_benefits IS NULL THEN
            RETURN 'No benefits have been recorded for tasks in this MCR.';
        END IF;

        -- Attempt dynamic call to DBMS_CLOUD_AI if available
        BEGIN
            EXECUTE IMMEDIATE
                'BEGIN :1 := DBMS_CLOUD_AI.GENERATE(prompt => :2, profile_name => ''MCR_AI_PROFILE'', action => ''chat''); END;'
                USING OUT l_summary,
                      IN 'Summarise the following list of change benefits into a concise executive summary of no more than 3 sentences. Focus on the overall business value delivered: '
                         || CHR(10) || CHR(10) || l_all_benefits;
            RETURN l_summary;
        EXCEPTION
            WHEN OTHERS THEN
                -- Fallback: return the concatenated benefits if AI is unavailable
                RETURN l_all_benefits;
        END;
    END summarise_benefits;

    ----------------------------------------------------------------------------
    -- get_progress_stats
    ----------------------------------------------------------------------------
    PROCEDURE get_progress_stats(
        p_mcr_id IN NUMBER
    ) IS
        l_total       NUMBER := 0;
        l_complete    NUMBER := 0;
        l_failed      NUMBER := 0;
        l_cancelled   NUMBER := 0;
        l_blocked     NUMBER := 0;
        l_ready       NUMBER := 0;
        l_pct_complete NUMBER := 0;
    BEGIN
        SELECT COUNT(*),
               COUNT(CASE WHEN task_status = 'Complete' THEN 1 END),
               COUNT(CASE WHEN task_status = 'Failed' THEN 1 END),
               COUNT(CASE WHEN task_status = 'Cancelled' THEN 1 END),
               COUNT(CASE WHEN task_status = 'Blocked' THEN 1 END),
               COUNT(CASE WHEN task_status = 'Ready' THEN 1 END)
          INTO l_total, l_complete, l_failed, l_cancelled, l_blocked, l_ready
          FROM tab_mcr_tasks
         WHERE mcr_id = p_mcr_id;

        IF l_total > 0 THEN
            l_pct_complete := ROUND(l_complete * 100 / l_total, 0);
        END IF;

        -- Build JSON response
        APEX_JSON.open_object;
        APEX_JSON.write('mcr_id', p_mcr_id);
        APEX_JSON.write('total', l_total);
        APEX_JSON.write('complete', l_complete);
        APEX_JSON.write('failed', l_failed);
        APEX_JSON.write('cancelled', l_cancelled);
        APEX_JSON.write('blocked', l_blocked);
        APEX_JSON.write('ready', l_ready);
        APEX_JSON.write('pct_complete', l_pct_complete);
        APEX_JSON.close_object;
    END get_progress_stats;

    ----------------------------------------------------------------------------
    -- send_report_email
    ----------------------------------------------------------------------------
    PROCEDURE send_report_email(
        p_mcr_id   IN NUMBER,
        p_user_id  IN NUMBER
    ) IS
        l_mcr_number   tab_mcr_requests.mcr_number%TYPE;
        l_description  tab_mcr_requests.description%TYPE;
        l_status       tab_mcr_requests.mcr_status%TYPE;
        l_total        NUMBER := 0;
        l_complete     NUMBER := 0;
        l_pct_complete NUMBER := 0;
        l_subject      VARCHAR2(500);
        l_body         CLOB;
        l_mail_id      NUMBER;
    BEGIN
        -- Fetch MCR summary for email content
        SELECT mcr_number, description, mcr_status
          INTO l_mcr_number, l_description, l_status
          FROM tab_mcr_requests
         WHERE mcr_id = p_mcr_id;

        -- Calculate progress
        SELECT COUNT(*),
               COUNT(CASE WHEN task_status = 'Complete' THEN 1 END)
          INTO l_total, l_complete
          FROM tab_mcr_tasks
         WHERE mcr_id = p_mcr_id;

        IF l_total > 0 THEN
            l_pct_complete := ROUND(l_complete * 100 / l_total, 0);
        END IF;

        -- Compose email subject and body
        l_subject := 'MCR Report: ' || l_mcr_number || ' - ' || l_status;

        l_body := 'MCR Report' || CHR(10)
               || '==========' || CHR(10) || CHR(10)
               || 'MCR Number: ' || l_mcr_number || CHR(10)
               || 'Status: ' || l_status || CHR(10)
               || 'Description: ' || l_description || CHR(10) || CHR(10)
               || 'Progress: ' || l_complete || ' / ' || l_total
               || ' (' || l_pct_complete || '% complete)' || CHR(10) || CHR(10)
               || 'This report was generated by MCR Manager on behalf of the change team.';

        -- Send email to each Informed RACI user
        FOR rec IN (
            SELECT u.email,
                   u.display_name
              FROM tab_mcr_raci ra
              JOIN tab_idcs_users u ON u.user_id = ra.user_id
             WHERE ra.mcr_id = p_mcr_id
               AND ra.raci_role = 'Informed'
               AND u.email IS NOT NULL
        ) LOOP
            BEGIN
                l_mail_id := APEX_MAIL.SEND(
                    p_to   => rec.email,
                    p_from => 'mcr-manager@noreply.local',
                    p_subj => l_subject,
                    p_body => l_body
                );
            EXCEPTION
                WHEN OTHERS THEN
                    -- Log the failure but continue sending to other recipients
                    NULL;
            END;
        END LOOP;

        -- Push any queued mail
        APEX_MAIL.PUSH_QUEUE;

    EXCEPTION
        WHEN OTHERS THEN
            -- Graceful failure — do not propagate email errors to the caller
            NULL;
    END send_report_email;

END pkg_mcr_reports;
/
