CREATE OR REPLACE PACKAGE pkg_password
AS
    /*
    ** PKG_PASSWORD - Password Generation and Reset Scheduling
    **
    ** Provides secure password generation using cryptographically random values
    ** and manages the automated password reset lifecycle after a reveal action.
    **
    ** Requirement 11.2: Generate random password (16+ chars, mixed character classes)
    ** Requirement 11.4: Initiate password reset workflow 15 minutes after reveal
    */

    /**
    * Generates a cryptographically random password of at least 16 characters.
    * The generated password contains at least one uppercase letter, one lowercase
    * letter, one digit, and one special character.
    *
    * @return VARCHAR2 The generated password string
    */
    FUNCTION generate_password RETURN VARCHAR2;

    /**
    * Records a password reveal action and schedules an automated password reset.
    * Inserts a PASSWORD_REVEAL_LOG record with reset_scheduled_at set to
    * SYSTIMESTAMP + INTERVAL '15' MINUTE, then initiates the WF_PASSWORD_RESET
    * workflow to perform the reset after the 15-minute window.
    *
    * @param p_event_id         The break-glass event ID for which the password was revealed
    * @param p_requesting_user  The username of the user who triggered the reveal
    */
    PROCEDURE schedule_password_reset (
        p_event_id        IN NUMBER,
        p_requesting_user IN VARCHAR2
    );

END pkg_password;
/
