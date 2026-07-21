/*
** mcr_users_module.sql
** ORDS REST Module: mcr_users
** Base Path: /mcr/v1/users/
**
** Provides user directory and department lookup endpoints for the MCR Manager
** application. Queries tab_idcs_users for user details and derives department
** list from distinct department_id values (tab_idcs_departments does not yet exist).
** Requirements: 2.1, 2.4, 2.5
*/

BEGIN
    ORDS.DEFINE_MODULE(
        p_module_name    => 'mcr_users',
        p_base_path      => '/mcr/v1/users/',
        p_items_per_page => 0,
        p_status         => 'PUBLISHED',
        p_comments       => 'User directory and department lookup for MCR Manager'
    );

    ---------------------------------------------------------------------------
    -- Template: GET /mcr/v1/users/
    -- Returns all users from tab_idcs_users
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_users',
        p_pattern        => '.',
        p_comments       => 'List all users'
    );

    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_users',
        p_pattern        => '.',
        p_method         => 'GET',
        p_source_type    => 'json/collection',
        p_source         => q'[
            SELECT user_id,
                   username,
                   display_name,
                   email,
                   manager_id,
                   department_id
              FROM tab_idcs_users
             ORDER BY display_name
        ]',
        p_comments       => 'GET handler - returns all users ordered by display name'
    );

    ---------------------------------------------------------------------------
    -- Template: GET /mcr/v1/users/:user_id
    -- Returns a single user's details
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_users',
        p_pattern        => ':user_id',
        p_comments       => 'Single user detail by user_id'
    );

    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_users',
        p_pattern        => ':user_id',
        p_method         => 'GET',
        p_source_type    => 'json/item',
        p_source         => q'[
            SELECT user_id,
                   username,
                   display_name,
                   email,
                   manager_id,
                   department_id
              FROM tab_idcs_users
             WHERE user_id = :user_id
        ]',
        p_comments       => 'GET handler - returns single user details'
    );

    ---------------------------------------------------------------------------
    -- Template: GET /mcr/v1/users/departments
    -- Returns distinct departments derived from tab_idcs_users
    -- (tab_idcs_departments table does not yet exist, so we derive from users)
    ---------------------------------------------------------------------------
    ORDS.DEFINE_TEMPLATE(
        p_module_name    => 'mcr_users',
        p_pattern        => 'departments',
        p_comments       => 'List all departments'
    );

    ORDS.DEFINE_HANDLER(
        p_module_name    => 'mcr_users',
        p_pattern        => 'departments',
        p_method         => 'GET',
        p_source_type    => 'json/collection',
        p_source         => q'[
            SELECT DISTINCT department_id,
                   'Department ' || department_id AS description
              FROM tab_idcs_users
             WHERE department_id IS NOT NULL
             ORDER BY department_id
        ]',
        p_comments       => 'GET handler - returns distinct departments from user table'
    );

    COMMIT;
END;
/
