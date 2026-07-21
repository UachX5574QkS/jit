-- TAB_MCR_REQUESTS table
-- Stores Managed Change Request records including ownership, scheduling, approval state, and lifecycle status.
-- Requirement 3.5, 15.1, 15.3: MCR creation with identity PK, status lifecycle, and naming convention.

CREATE TABLE tab_mcr_requests (
    mcr_id                 NUMBER GENERATED ALWAYS AS IDENTITY
                           CONSTRAINT con_mcr_requests_pk PRIMARY KEY,
    mcr_number             VARCHAR2(100)  NOT NULL
                           CONSTRAINT con_mcr_requests_number_uk UNIQUE,
    owner_user_id          NUMBER         NOT NULL
                           CONSTRAINT con_mcr_requests_owner_fk
                           REFERENCES tab_idcs_users(user_id),
    description            VARCHAR2(4000) NOT NULL,
    estimated_start_date   DATE           NOT NULL,
    estimated_end_date     DATE           NOT NULL,
    mcr_status             VARCHAR2(30)   DEFAULT 'Draft' NOT NULL
                           CONSTRAINT con_mcr_requests_status_chk
                           CHECK (mcr_status IN (
                               'Draft','Review','Pending','Partial',
                               'Approved','Locked','Active','Complete',
                               'Partial_Complete','Cancelled','DNF'
                           )),
    approved_by_user_id    NUMBER
                           CONSTRAINT con_mcr_requests_approved_fk
                           REFERENCES tab_idcs_users(user_id),
    approved_at            TIMESTAMP WITH TIME ZONE,
    created_at             TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
    updated_at             TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
    created_by_user_id     NUMBER         NOT NULL
                           CONSTRAINT con_mcr_requests_created_fk
                           REFERENCES tab_idcs_users(user_id),
    CONSTRAINT con_mcr_requests_dates_chk CHECK (estimated_end_date >= estimated_start_date)
);

COMMENT ON TABLE tab_mcr_requests IS 'Managed Change Request records with ownership, scheduling, approval tracking, and lifecycle status';
COMMENT ON COLUMN tab_mcr_requests.mcr_id IS 'Surrogate primary key (identity column)';
COMMENT ON COLUMN tab_mcr_requests.mcr_number IS 'User-assigned unique MCR identifier (e.g., MCR-2025-001)';
COMMENT ON COLUMN tab_mcr_requests.owner_user_id IS 'Foreign key to tab_idcs_users identifying the MCR owner';
COMMENT ON COLUMN tab_mcr_requests.description IS 'Description of the managed change request';
COMMENT ON COLUMN tab_mcr_requests.estimated_start_date IS 'Planned start date for the MCR execution window';
COMMENT ON COLUMN tab_mcr_requests.estimated_end_date IS 'Planned end date for the MCR execution window';
COMMENT ON COLUMN tab_mcr_requests.mcr_status IS 'Current lifecycle status: Draft, Review, Pending, Partial, Approved, Locked, Active, Complete, Partial_Complete, Cancelled, DNF';
COMMENT ON COLUMN tab_mcr_requests.approved_by_user_id IS 'Foreign key to tab_idcs_users identifying the user who last approved';
COMMENT ON COLUMN tab_mcr_requests.approved_at IS 'Timestamp of the last approval action';
COMMENT ON COLUMN tab_mcr_requests.created_at IS 'Record creation timestamp';
COMMENT ON COLUMN tab_mcr_requests.updated_at IS 'Last modification timestamp';
COMMENT ON COLUMN tab_mcr_requests.created_by_user_id IS 'Foreign key to tab_idcs_users identifying the creating user';
