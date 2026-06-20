// Event types
export type EventType = 'GROUP' | 'PASSWORD';
export type EventStatus =
  | 'started'
  | 'approval_pending'
  | 'approved'
  | 'denied'
  | 'expired'
  | 'active'
  | 'revoked'
  | 'revocation_failed'
  | 'password_revealed'
  | 'password_reset'
  | 'audit_captured'
  | 'audit_capture_failed'
  | 'error';
export type ApprovalAction = 'APPROVE' | 'DENY';

// Break Glass Event
export interface BreakGlassEvent {
  event_id: number;
  event_type: EventType;
  target_identifier: string;
  requesting_user: string;
  approver_username: string | null;
  status: EventStatus;
  start_time: string; // ISO8601
  end_time: string; // ISO8601
  ticket_reference: string;
  description: string;
  created_at: string;
  updated_at: string;
}

// Request payload for creating an event
export interface CreateEventRequest {
  event_type: EventType;
  target_identifier: string;
  start_time: string;
  end_time: string;
  ticket_reference: string;
  description: string;
  approver_username: string | null;
}

// Response from event creation
export interface CreateEventResponse {
  event_id: number;
  status: string;
  created_at: string;
}

// Target discovery
export interface GroupTarget {
  group_name: string;
  elevated_group: string;
  approvers_group: string;
}

export interface PasswordTarget {
  user_name: string;
  elevated_group: string;
  approvers_group: string;
}

export interface TargetResponse {
  group_targets: GroupTarget[];
  password_targets: PasswordTarget[];
}

// Approvers
export interface Approver {
  username: string;
  display_name: string;
  email: string;
}

export interface ApproverResponse {
  approvers: Approver[];
}

// Password reveal
export interface PasswordRevealRequest {
  event_id: number;
}

export interface PasswordRevealResponse {
  password: string;
  expires_in_minutes: number;
}

// Approval action
export interface ApprovalActionRequest {
  action: ApprovalAction;
  comment?: string;
}

export interface ApprovalActionResponse {
  event_id: number;
  status: string;
  actioned_at: string;
}

// Auth
export interface AuthResponse {
  groups: string[];
}

// Events list
export interface EventsListResponse {
  items: BreakGlassEvent[];
}

// Error
export interface ErrorResponse {
  error: string | { code: string; message: string };
}

// Admin tenancy
export interface IdcsTenancy {
  tenancy_id: number;
  tenancy_identifier: string;
  stripe_url: string;
  client_id: string;
  client_secret?: string;
  created_at: string;
  updated_at: string;
}

export interface TenancyListResponse {
  items: IdcsTenancy[];
}

export interface CreateTenancyRequest {
  tenancy_identifier: string;
  stripe_url: string;
  client_id: string;
  client_secret: string;
}
