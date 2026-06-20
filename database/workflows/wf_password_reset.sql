/*
** =============================================================================
** APEX Workflow Definition: WF_PASSWORD_RESET
** =============================================================================
**
** Purpose:
**   Automatically resets an IDCS user password 15 minutes after it was revealed,
**   ensuring that the revealed password is only usable for a limited window.
**
** Trigger:
**   Initiated by the password reveal action (POST /jit/v1/password/reveal)
**   after a successful password reveal. Also initiated by
**   PKG_PASSWORD.schedule_password_reset.
**
** Workflow Parameters (bound from the PASSWORD_REVEAL_LOG and Break_Glass_Event):
**   :event_id           - The break-glass event identifier
**   :requesting_user    - Username of the person who revealed the password
**   :target_identifier  - Name of the target IDCS user account
**   :tenancy_id         - FK to IDCS_TENANCY record
**
** Activity Flow:
**   START
**     → wait_15_minutes
**     → reset_password (with retry: 3 retries, 1-minute interval)
**     → BRANCH:
**         ├─ [success] → END
**         └─ [failure] → END
**
** Requirements: 11.4, 11.7, 13.6, 13.7
** =============================================================================
*/

--------------------------------------------------------------------------------
-- ACTIVITY: wait_15_minutes
-- Type: Wait / Timer
-- Duration: INTERVAL '15' MINUTE
-- Description: Pauses workflow execution for 15 minutes after the password
--              was revealed, giving the user time to use the password before
--              it is automatically rotated.
--
-- Configuration:
--   - Wait Duration: INTERVAL '15' MINUTE
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- ACTIVITY: reset_password
-- Type: Execute Code
-- Retry Configuration: 3 retries, 1-minute (60-second) interval
-- Description: Generates a new random password and sets it on the target IDCS
--              user account, invalidating the previously revealed password.
--              Updates PASSWORD_REVEAL_LOG with the outcome.
--------------------------------------------------------------------------------
-- Activity PL/SQL:
DECLARE
    l_new_password   VARCHAR2(128);
    l_success        BOOLEAN := FALSE;
    l_retry_count    NUMBER  := 0;
    l_max_retries    CONSTANT NUMBER := 3;
    l_retry_interval CONSTANT NUMBER := 60; -- seconds (1 minute)
BEGIN
    -- Attempt password reset with retry logic
    LOOP
        BEGIN
            -- Generate a new cryptographically random password
            l_new_password := PKG_PASSWORD.generate_password;

            -- Set the new password on the IDCS user account
            PKG_IDCS.set_user_password(
                p_tenancy_id   => :tenancy_id,
                p_username     => :target_identifier,
                p_new_password => l_new_password
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
        -- Password reset succeeded
        UPDATE password_reveal_log
           SET reset_status       = 'completed',
               reset_completed_at = SYSTIMESTAMP
         WHERE event_id     = :event_id
           AND reset_status = 'pending';
    ELSE
        -- Password reset failed after all retries
        UPDATE password_reveal_log
           SET reset_status = 'failed',
               retry_count  = l_max_retries
         WHERE event_id     = :event_id
           AND reset_status = 'pending';
    END IF;
END;
/

--------------------------------------------------------------------------------
-- END
-- Workflow terminates after the reset attempt completes (success or failure).
-- On failure, the PASSWORD_REVEAL_LOG record is marked as 'failed' and
-- retry_count is set to 3 for administrator review.
--------------------------------------------------------------------------------
