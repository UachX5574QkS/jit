-- TAB_MCR_RACI table
-- Stores RACI (Responsible, Accountable, Consulted, Informed) assignments for each MCR.
-- Requirement 3.2, 15.1: Record RACI matrix entries linking users to MCR roles.

CREATE TABLE tab_mcr_raci (
    raci_id              NUMBER GENERATED ALWAYS AS IDENTITY
                         CONSTRAINT con_mcr_raci_pk PRIMARY KEY,
    mcr_id               NUMBER         NOT NULL
                         CONSTRAINT con_mcr_raci_mcr_fk
                         REFERENCES tab_mcr_requests(mcr_id),
    user_id              NUMBER         NOT NULL
                         CONSTRAINT con_mcr_raci_user_fk
                         REFERENCES tab_idcs_users(user_id),
    raci_role            VARCHAR2(20)   NOT NULL
                         CONSTRAINT con_mcr_raci_role_chk
                         CHECK (raci_role IN ('Responsible', 'Accountable', 'Consulted', 'Informed'))
);

COMMENT ON TABLE tab_mcr_raci IS 'RACI responsibility assignments linking users to MCR roles';
COMMENT ON COLUMN tab_mcr_raci.raci_id IS 'Surrogate primary key (identity column)';
COMMENT ON COLUMN tab_mcr_raci.mcr_id IS 'Foreign key to the parent MCR request';
COMMENT ON COLUMN tab_mcr_raci.user_id IS 'Foreign key to the assigned user in tab_idcs_users';
COMMENT ON COLUMN tab_mcr_raci.raci_role IS 'RACI role: Responsible, Accountable, Consulted, or Informed';
