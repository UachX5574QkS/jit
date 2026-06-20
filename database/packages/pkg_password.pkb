CREATE OR REPLACE PACKAGE BODY pkg_password
AS
    /*
    ** PKG_PASSWORD Package Body
    **
    ** Implements secure password generation and password reset scheduling.
    **
    ** Requirement 11.2: Generate random password (16+ chars, mixed character classes)
    ** Requirement 11.4: Initiate password reset workflow 15 minutes after reveal
    ** Requirement 11.7: Retry reset up to 3 times on failure and log for admin review
    */

    -- Character class constants
    gc_upper   CONSTANT VARCHAR2(26) := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    gc_lower   CONSTANT VARCHAR2(26) := 'abcdefghijklmnopqrstuvwxyz';
    gc_digits  CONSTANT VARCHAR2(10) := '0123456789';
    gc_special CONSTANT VARCHAR2(16) := '!@#$%^&*()-_=+[]';

    -- Password length
    gc_password_length CONSTANT PLS_INTEGER := 20;

    ---------------------------------------------------------------------------
    -- GENERATE_PASSWORD
    ---------------------------------------------------------------------------
    FUNCTION generate_password RETURN VARCHAR2
    IS
        l_password    VARCHAR2(100);
        l_all_chars   VARCHAR2(78);
        l_char_pool   VARCHAR2(100);
        l_position    PLS_INTEGER;
        l_temp_char   VARCHAR2(1);
        l_swap_pos    PLS_INTEGER;

        -- Helper: pick a random character from a given string
        FUNCTION random_char(p_chars IN VARCHAR2) RETURN VARCHAR2
        IS
        BEGIN
            RETURN SUBSTR(p_chars, TRUNC(DBMS_RANDOM.VALUE(1, LENGTH(p_chars) + 1)), 1);
        END random_char;

    BEGIN
        -- Combined pool for filler characters
        l_all_chars := gc_upper || gc_lower || gc_digits || gc_special;

        -- Step 1: Guarantee at least one character from each required class
        l_password := random_char(gc_upper)
                   || random_char(gc_lower)
                   || random_char(gc_digits)
                   || random_char(gc_special);

        -- Step 2: Fill remaining positions with random characters from all classes
        FOR i IN 5 .. gc_password_length LOOP
            l_password := l_password || random_char(l_all_chars);
        END LOOP;

        -- Step 3: Shuffle the password using Fisher-Yates algorithm
        l_char_pool := l_password;
        l_password := '';

        FOR i IN REVERSE 2 .. LENGTH(l_char_pool) LOOP
            l_swap_pos := TRUNC(DBMS_RANDOM.VALUE(1, i + 1));

            -- Build shuffled string by swapping characters
            l_temp_char := SUBSTR(l_char_pool, i, 1);
            l_char_pool := SUBSTR(l_char_pool, 1, i - 1)
                        || SUBSTR(l_char_pool, i + 1);

            l_char_pool := SUBSTR(l_char_pool, 1, l_swap_pos - 1)
                        || l_temp_char
                        || SUBSTR(l_char_pool, l_swap_pos);
        END LOOP;

        l_password := l_char_pool;

        RETURN l_password;
    END generate_password;

    ---------------------------------------------------------------------------
    -- SCHEDULE_PASSWORD_RESET
    ---------------------------------------------------------------------------
    PROCEDURE schedule_password_reset (
        p_event_id        IN NUMBER,
        p_requesting_user IN VARCHAR2
    )
    IS
        l_revealed_at        TIMESTAMP WITH TIME ZONE := SYSTIMESTAMP;
        l_reset_scheduled_at TIMESTAMP WITH TIME ZONE := l_revealed_at + INTERVAL '15' MINUTE;
    BEGIN
        -- Insert PASSWORD_REVEAL_LOG record
        INSERT INTO password_reveal_log (
            event_id,
            requesting_user,
            revealed_at,
            reset_scheduled_at,
            reset_status,
            retry_count
        ) VALUES (
            p_event_id,
            p_requesting_user,
            l_revealed_at,
            l_reset_scheduled_at,
            'pending',
            0
        );

        -- TODO: Initiate WF_PASSWORD_RESET workflow
        -- In a full implementation, this would call:
        --   APEX_WORKFLOW.START_WORKFLOW(
        --       p_static_id     => 'WF_PASSWORD_RESET',
        --       p_initiator     => p_requesting_user,
        --       p_parameters    => apex_workflow.t_workflow_parameters(
        --           apex_workflow.t_workflow_parameter(
        --               static_id => 'EVENT_ID', value => TO_CHAR(p_event_id)
        --           )
        --       )
        --   );
        -- The workflow will wait 15 minutes, then call PKG_PASSWORD.generate_password
        -- and PKG_IDCS.set_user_password to reset the password, with up to 3 retries.

        COMMIT;
    END schedule_password_reset;

END pkg_password;
/
