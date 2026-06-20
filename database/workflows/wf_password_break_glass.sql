/*
** =============================================================================
** APEX Workflow Definition: WF_PASSWORD_BREAK_GLASS
** =============================================================================
**
** Purpose:
**   Orchestrates the approval lifecycle for a Password Break-Glass request.
**   The workflow handles approval routing and status transitions only.
**   Password reveal is handled on-demand by the ORDS endpoint (POST /jit/v1/password/reveal),
**   not by this workflow.
**
** Trigger:
**   Initiated when a Password break-glass event is created (POST /jit/v1/events/)
**
** Workflow Parameters (bound from the initiating Break_Glass_Event record):
**   :event_id           - The break-glass event identifier
**   :requesting_user    - Username of the person requesting access
**   :approver_username  - Username of the designated approver
**   :target_identifier  - Name of the target IDCS user account
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
**     → wait_for_approval (deadline = 72 hours from workflow start)
**     → BRANCH:
**         ├─ [approved] → handle_approval → END
**         ├─ [denied]   → handle_denial → END
**         └─ [expired]  → handle_expiry → END
**
** Requirements: 10.1, 10.4, 10.5, 10.6, 13.3, 13.4
** =============================================================================
*/

--------------------------------------------------------------------------------
-- ACTIVITY: send_approval_notification
-- Type: Execute Code
-- Description: Sends an approval request email to the designated approver
--              containing the requesting user's identity, target account, and
--              stated justification.
--------------------------------------------------------------------------------
-- Activity PL/SQL:
BEGIN
    PKG_NOTIFICATIONS.notify_approver(
        p_event_id         => :event_id,
        p_approver_email   => :approver_email,
        p_requesting_user  => :requesting_user,
        p_target           => :target_identifier,
        p_event_type       => 'PASSWORD',
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
-- Deadline: 72 hours from workflow initiation (INTERVAL '72' HOUR)
-- Description: Pauses workflow execution until the approver takes action
--              (approve or deny) or the 72-hour deadline is reached.
--
-- Configuration:
--   - Task Owner: :approver_username
--   - Due Date: SYSTIMESTAMP + INTERVAL '72' HOUR (calculated at activity start)
--   - Expiration Action: Route to 'handle_expiry' branch
--   - Outcome Values: 'APPROVED', 'DENIED'
--
-- On Outcome = 'APPROVED': Route to 'handle_approval'
-- On Outcome = 'DENIED':   Route to 'handle_denial'
-- On Deadline Reached:     Route to 'handle_expiry'
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- BRANCH: approved → handle_approval
-- Type: Execute Code
-- Description: Updates event status to 'approved' and notifies the requester.
--              The actual password reveal is triggered by the user on demand
--              via the ORDS endpoint POST /jit/v1/password/reveal.
--------------------------------------------------------------------------------
-- Activity PL/SQL:
BEGIN
    PKG_BREAK_GLASS.update_event_status(
        p_event_id      => :event_id,
        p_new_status    => 'approved',
        p_changed_by    => :approver_username,
        p_change_reason => 'Request approved by approver'
    );

    PKG_NOTIFICATIONS.notify_requester_approved(
        p_event_id        => :event_id,
        p_requester_email => :requester_email,
        p_target          => :target_identifier,
        p_event_type      => 'PASSWORD'
    );
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
        p_event_type      => 'PASSWORD'
    );
END;
/

--------------------------------------------------------------------------------
-- BRANCH: expired → handle_expiry
-- Type: Execute Code
-- Description: Updates event status to 'expired' and notifies the requester.
--              Triggered when the 72-hour approval window passes without
--              an approver action.
--------------------------------------------------------------------------------
-- Activity PL/SQL:
BEGIN
    PKG_BREAK_GLASS.update_event_status(
        p_event_id      => :event_id,
        p_new_status    => 'expired',
        p_changed_by    => 'WORKFLOW',
        p_change_reason => 'Approval not received within 72-hour deadline'
    );

    PKG_NOTIFICATIONS.notify_requester_expired(
        p_event_id        => :event_id,
        p_requester_email => :requester_email,
        p_target          => :target_identifier,
        p_event_type      => 'PASSWORD'
    );
END;
/

--------------------------------------------------------------------------------
-- END
-- Workflow terminates after reaching any of the terminal activities.
-- Password reveal is available on-demand through the ORDS endpoint while
-- the event is in 'approved' status and within the time window.
--------------------------------------------------------------------------------
