-- IDCS_TENANCY table
-- Stores IDCS tenancy configuration records including connection details and authentication keys.
-- Requirement 2.1: Store IDCS_Tenancy records with tenancy identifier (unique), stripe URL, and authentication keys.

CREATE TABLE idcs_tenancy (
    tenancy_id         NUMBER GENERATED ALWAYS AS IDENTITY
                       CONSTRAINT idcs_tenancy_pk PRIMARY KEY,
    tenancy_identifier VARCHAR2(100)  NOT NULL
                       CONSTRAINT idcs_tenancy_identifier_uk UNIQUE,
    stripe_url         VARCHAR2(500)  NOT NULL,
    client_id          VARCHAR2(200)  NOT NULL,
    client_secret      VARCHAR2(500)  NOT NULL,
    created_at         TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL,
    updated_at         TIMESTAMP WITH TIME ZONE DEFAULT SYSTIMESTAMP NOT NULL
);

COMMENT ON TABLE idcs_tenancy IS 'Configured IDCS tenancy records with connection details and OAuth2 authentication keys';
COMMENT ON COLUMN idcs_tenancy.tenancy_id IS 'Surrogate primary key (identity column)';
COMMENT ON COLUMN idcs_tenancy.tenancy_identifier IS 'Human-readable unique tenancy identifier';
COMMENT ON COLUMN idcs_tenancy.stripe_url IS 'IDCS stripe base URL for API calls';
COMMENT ON COLUMN idcs_tenancy.client_id IS 'OAuth2 client ID for IDCS API access';
COMMENT ON COLUMN idcs_tenancy.client_secret IS 'OAuth2 client secret (encrypted at rest via TDE)';
COMMENT ON COLUMN idcs_tenancy.created_at IS 'Record creation timestamp';
COMMENT ON COLUMN idcs_tenancy.updated_at IS 'Last modification timestamp';
