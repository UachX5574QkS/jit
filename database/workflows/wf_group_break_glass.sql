/*
** =============================================================================
** APEX Workflow Definition: WF_GROUP_BREAK_GLASS
** =============================================================================
**
** Purpose:
**   Orchestrates the full lifecycle of a Group Break-Glass request:
**   approval → grant elevated access → wait for time window end → revoke access.
**
** Trigger:
**   Initiated when a Group break-glass event is created (POST /jit/v1/events/)
**
** Workflow Parameters (bound from the initiating Break_Glass_Event record):
**   :event_id           - The break-glass event identifier
**   :requesting_user    - Username of the person requesting access
**   :approver_username  - Username of the designated approver
**   :target_identifier  - Name of the target IDCS group (elevated group)
**   :tenancy_id         - FK to IDCS_TENANCY record
**   :start_time         - Start of the requested time window (TIMESTAMP WITH TIME ZONE)
**   :end_time           - End of the requested time window (TIMESTAMP WITH TIME ZONE)
**   :ticket_reference   - External ticket/incident reference
**   :requester_email    - Email address of the requesting user
**   :approver_email     - Email address of the approver
**
** Activity Flow:
**   START
**     → send_approval_notification
**     → wait_for_approval (deadline = :start_time)
**     → BRANCH:
**         ├─ [approved]  → grant_elevated_access → wait_until_end_time
**         │                 → revoke_elevated_access → END
**         ├─ [denied]    → handle_denial → END
**         └─ [expired]   → handle_expiry → END
**
** Requirements: 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7,
**               13.1, 13.2, 13.6, 13.7
** =============================================================================
*/

--------------------------------------------------------------------------------
-- ACTIVITY: send_approval_notification
-- Type: Execute Code
-- Description: Sends an approval request email to the designated approver.
--------------------------------------------------------------------------------
-- Activity PL/SQL:
BEGIN
    PKG_NOTIFICATIONS.notify_approver(
        p_event_id         => :event_id,
        p_approver_email   => :approver_email,
        p_requesting_user  => :requesting_user,
        p_target           => :target_identifier,
        p_event_type       => 'GROUP',
        p_start_time       => :start_time,
        p_end_time         => :end_time,
        p_ticket_reference => :ticket_reference,
        p_action_url       => :approval_action_url
    );

    PKG_BREAK_GLASS.update_event_status(
        p_event_id      => :event_id,
        p_new_status    => 'approval_pending',
        p_changed_by    => 'WORKFLOW',
        p_change_reason => 'Approval notification sent to ' || :approver_username
    );
END;
/

--------------------------------------------------------------------------------
-- ACTIVITY: wait_for_approval
-- Type: Wait for Approval / Human Task
-- Deadline: :start_time (the event start time)
-- Description: Pauses workflow execution until the approver takes action
--              (approve or deny) or the deadline is reached.
--
-- Configuration:
--   - Task Owner: :approver_username
--   - Due Date: :start_time
--   - Expiration Action: Route to 'handle_expiry' branch
--   - Outcome Values: 'APPROVED', 'DENIED'
--
-- On Outcome = 'APPROVED': Route to 'grant_elevated_access'
-- On Outcome = 'DENIED':   Route to 'handle_denial'
-- On Deadline Reached:     Route to 'handle_expiry'
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- BRANCH: approved → grant_elevated_access
-- Type: Execute Code
-- Retry Configuration: 3 retries, 30-second interval
-- Description: Adds the requesting user to the elevated IDCS group.
--------------------------------------------------------------------------------
-- Activity PL/SQL:
DECLARE
    l_elevated_group VARCHAR2(256);
BEGIN
    -- The elevated group is the target group with '_elevated' suffix
    l_elevated_group := :target_identifier || '_elevated';

    -- Add user to the elevated IDCS group
    PKG_IDCS.add_group_member(
        p_tenancy_id => :tenancy_id,
        p_group_name => l_elevated_group,
        p_username   => :requesting_user
    );

    -- Update event status to 'active'
    PKG_BREAK_GLASS.update_event_status(
        p_event_id      => :event_id,
        p_new_status    => 'active',
        p_changed_by    => 'WORKFLOW',
        p_change_reason => 'User added to elevated group: ' || l_elevated_group
    );

    -- Notify requester that access has been granted
    PKG_NOTIFICATIONS.notify_requester_approved(
        p_event_id        => :event_id,
        p_requester_email => :requester_email,
        p_target          => :target_identifier,
        p_event_type      => 'GROUP'
    );
END;
/

--------------------------------------------------------------------------------
-- ACTIVITY: wait_until_end_time
-- Type: Wait / Timer
-- Duration: Until :end_time
-- Description: Pauses workflow execution until the time window end is reached.
--
-- Configuration:
--   - Wait Until: :end_time (TIMESTAMP WITH TIME ZONE)
--   - If :end_time is already past, proceed immediately.
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- ACTIVITY: revoke_elevated_access
-- Type: Execute Code
-- Retry Configuration: 3 retries, 30-second interval
-- Description: Removes the requesting user from the elevated IDCS group at the
--              end of the time window. On success, marks event as 'revoked'.
--              On failure after retries, marks event as 'revocation_failed'.
--------------------------------------------------------------------------------
-- Activity PL/SQL:
DECLARE
    l_elevated_group VARCHAR2(256);
    l_success        BOOLEAN := FALSE;
    l_retry_count    NUMBER  := 0;
    l_max_retries    CONSTANT NUMBER := 3;
    l_retry_interval CONSTANT NUMBER := 30; -- seconds
BEGIN
    l_elevated_group := :target_identifier || '_elevated';

    -- Attempt revocation with retry logic
    LOOP
        BEGIN
            PKG_IDCS.remove_group_member(
                p_tenancy_id => :tenancy_id,
                p_group_name => l_elevated_group,
                p_username   => :requesting_user
            );
            l_success := TRUE;
            EXIT; -- Success, exit retry loop
        EXCEPTION
            WHEN OTHERS THEN
                l_retry_count := l_retry_count + 1;
                IF l_retry_count >= l_max_retries THEN
                    EXIT; -- Exhausted retries
                END IF;
                -- Wait before retrying
                DBMS_SESSION.SLEEP(l_retry_interval);
        END;
    END LOOP;

    IF l_success THEN
        -- Revocation succeeded
        PKG_BREAK_GLASS.update_event_status(
            p_event_id      => :event_id,
            p_new_status    => 'revoked',
            p_changed_by    => 'WORKFLOW',
            p_change_reason => 'User removed from elevated group: ' || l_elevated_group
        );

        PKG_NOTIFICATIONS.notify_requester_approved(
            p_event_id        => :event_id,
            p_requester_email => :requester_email,
            p_target          => :target_identifier,
            p_event_type      => 'GROUP'
        );
    ELSE
        -- Revocation failed after all retries
        PKG_BREAK_GLASS.update_event_status(
            p_event_id      => :event_id,
            p_new_status    => 'revocation_failed',
            p_changed_by    => 'WORKFLOW',
            p_change_reason => 'Failed to remove user from elevated group after '
                               || l_max_retries || ' retries'
        );

        PKG_NOTIFICATIONS.notify_revocation_failed(
            p_event_id        => :event_id,
            p_requester_email => :requester_email,
            p_approver_email  => :approver_email,
            p_target          => :target_identifier
        );
    END IF;
END;
/

--------------------------------------------------------------------------------
-- BRANCH: denied → handle_denial
-- Type: Execute Code
-- Description: Updates event status to 'denied' and notifies the requester.
--------------------------------------------------------------------------------
-- Activity PL/SQL:
BEGIN
    PKG_BREAK_GLASS.update_event_status(
        p_event_id      => :event_id,
        p_new_status    => 'denied',
        p_changed_by    => :approver_username,
        p_change_reason => 'Request denied by approver'
    );

    PKG_NOTIFICATIONS.notify_requester_denied(
        p_event_id        => :event_id,
        p_requester_email => :requester_email,
        p_target          => :target_identifier,
        p_event_type      => 'GROUP'
    );
END;
/

--------------------------------------------------------------------------------
-- BRANCH: expired → handle_expiry
-- Type: Execute Code
-- Description: Updates event status to 'expired' and notifies the requester.
--              Triggered when the approval deadline (start_time) passes without
--              an approver action.
--------------------------------------------------------------------------------
-- Activity PL/SQL:
BEGIN
    PKG_BREAK_GLASS.update_event_status(
        p_event_id      => :event_id,
        p_new_status    => 'expired',
        p_changed_by    => 'WORKFLOW',
        p_change_reason => 'Approval not received before start time deadline'
    );

    PKG_NOTIFICATIONS.notify_requester_expired(
        p_event_id        => :event_id,
        p_requester_email => :requester_email,
        p_target          => :target_identifier,
        p_event_type      => 'GROUP'
    );
END;
/

--------------------------------------------------------------------------------
-- END
-- Workflow terminates after reaching any of the terminal activities.
--------------------------------------------------------------------------------
