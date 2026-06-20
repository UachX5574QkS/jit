import type {
  AuthResponse,
  TargetResponse,
  ApproverResponse,
  EventsListResponse,
  BreakGlassEvent,
  TenancyListResponse,
} from '../types/api';

const now = new Date();
const oneHourFromNow = new Date(now.getTime() + 60 * 60 * 1000);
const twoHoursFromNow = new Date(now.getTime() + 2 * 60 * 60 * 1000);
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);

export const mockAuth: AuthResponse = {
  groups: [
    'jit_dba',
    'jit_dba_approvers',
    'jit_dba_elevated',
    'jit_network',
    'jit_network_approvers',
    'jit_network_elevated',
    'inf_idcsuser_admin',
    'inf_idcsuser_admin_approvers',
    'inf_idcsuser_admin_elevated',
    'inf_idcsuser_svc_backup',
    'inf_idcsuser_svc_backup_approvers',
    'inf_idcsuser_svc_backup_elevated',
  ],
};

export const mockTargets: TargetResponse = {
  group_targets: [
    { group_name: 'dba', elevated_group: 'jit_dba_elevated', approvers_group: 'jit_dba_approvers' },
    { group_name: 'network', elevated_group: 'jit_network_elevated', approvers_group: 'jit_network_approvers' },
  ],
  password_targets: [
    { user_name: 'admin', elevated_group: 'inf_idcsuser_admin_elevated', approvers_group: 'inf_idcsuser_admin_approvers' },
    { user_name: 'svc_backup', elevated_group: 'inf_idcsuser_svc_backup_elevated', approvers_group: 'inf_idcsuser_svc_backup_approvers' },
  ],
};

export const mockApprovers: ApproverResponse = {
  approvers: [
    { username: 'jane.smith@example.com', display_name: 'Jane Smith', email: 'jane.smith@example.com' },
    { username: 'bob.jones@example.com', display_name: 'Bob Jones', email: 'bob.jones@example.com' },
    { username: 'alice.wong@example.com', display_name: 'Alice Wong', email: 'alice.wong@example.com' },
  ],
};

export const mockEvents: EventsListResponse = {
  items: [
    {
      event_id: 1,
      event_type: 'GROUP',
      target_identifier: 'dba',
      requesting_user: 'hugh.smith@example.com',
      approver_username: 'jane.smith@example.com',
      status: 'active',
      start_time: yesterday.toISOString(),
      end_time: oneHourFromNow.toISOString(),
      ticket_reference: 'INC-2024-001',
      description: 'Emergency database maintenance - connection pool exhaustion',
      created_at: yesterday.toISOString(),
      updated_at: yesterday.toISOString(),
    },
    {
      event_id: 2,
      event_type: 'PASSWORD',
      target_identifier: 'admin',
      requesting_user: 'hugh.smith@example.com',
      approver_username: 'bob.jones@example.com',
      status: 'approved',
      start_time: now.toISOString(),
      end_time: twoHoursFromNow.toISOString(),
      ticket_reference: 'MCR-5567',
      description: 'Need admin password to reset service account configurations',
      created_at: new Date(now.getTime() - 30 * 60 * 1000).toISOString(),
      updated_at: new Date(now.getTime() - 15 * 60 * 1000).toISOString(),
    },
    {
      event_id: 3,
      event_type: 'GROUP',
      target_identifier: 'network',
      requesting_user: 'hugh.smith@example.com',
      approver_username: 'alice.wong@example.com',
      status: 'approval_pending',
      start_time: oneHourFromNow.toISOString(),
      end_time: new Date(oneHourFromNow.getTime() + 4 * 60 * 60 * 1000).toISOString(),
      ticket_reference: 'CHG-2024-789',
      description: 'Firewall rule update for new microservice deployment',
      created_at: new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
      updated_at: new Date(now.getTime() - 10 * 60 * 1000).toISOString(),
    },
    {
      event_id: 4,
      event_type: 'GROUP',
      target_identifier: 'dba',
      requesting_user: 'hugh.smith@example.com',
      approver_username: 'jane.smith@example.com',
      status: 'revoked',
      start_time: threeDaysAgo.toISOString(),
      end_time: twoDaysAgo.toISOString(),
      ticket_reference: 'INC-2024-098',
      description: 'Schema migration for Q4 release',
      created_at: threeDaysAgo.toISOString(),
      updated_at: twoDaysAgo.toISOString(),
    },
    {
      event_id: 5,
      event_type: 'PASSWORD',
      target_identifier: 'svc_backup',
      requesting_user: 'hugh.smith@example.com',
      approver_username: 'bob.jones@example.com',
      status: 'denied',
      start_time: twoDaysAgo.toISOString(),
      end_time: new Date(twoDaysAgo.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      ticket_reference: 'REQ-4456',
      description: 'Backup service account password for disaster recovery test',
      created_at: twoDaysAgo.toISOString(),
      updated_at: twoDaysAgo.toISOString(),
    },
  ] as BreakGlassEvent[],
};

export const mockTenancies: TenancyListResponse = {
  items: [
    {
      tenancy_id: 1,
      tenancy_identifier: 'production-uk',
      stripe_url: 'https://idcs-abc123.identity.oraclecloud.com',
      client_id: 'client_prod_uk_001',
      created_at: '2024-01-15T10:00:00.000+00:00',
      updated_at: '2024-06-01T14:30:00.000+00:00',
    },
    {
      tenancy_id: 2,
      tenancy_identifier: 'staging-uk',
      stripe_url: 'https://idcs-def456.identity.oraclecloud.com',
      client_id: 'client_stg_uk_002',
      created_at: '2024-02-20T09:00:00.000+00:00',
      updated_at: '2024-05-10T11:15:00.000+00:00',
    },
  ],
};
