import type {
  AuthResponse,
  TargetResponse,
  ApproverResponse,
  CreateEventRequest,
  CreateEventResponse,
  EventsListResponse,
  PasswordRevealRequest,
  PasswordRevealResponse,
  ApprovalActionRequest,
  ApprovalActionResponse,
  TenancyListResponse,
  IdcsTenancy,
  CreateTenancyRequest,
  ErrorResponse,
} from '../types/api';

const BASE_URL = './ords/jit/v1';

export class ApiError extends Error {
  status: number;
  body: ErrorResponse;

  constructor(status: number, body: ErrorResponse) {
    const message =
      typeof body.error === 'string'
        ? body.error
        : body.error.message;
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!response.ok) {
    const error: ErrorResponse = await response.json();
    throw new ApiError(response.status, error);
  }
  return response.json() as Promise<T>;
}

// Auth
export function getAuth(): Promise<AuthResponse> {
  return request<AuthResponse>(`${BASE_URL}/auth/`);
}

// Targets
export function getTargets(): Promise<TargetResponse> {
  return request<TargetResponse>(`${BASE_URL}/targets/`);
}

export function getApprovers(type: string, name: string): Promise<ApproverResponse> {
  return request<ApproverResponse>(
    `${BASE_URL}/targets/${encodeURIComponent(type)}/${encodeURIComponent(name)}/approvers`
  );
}

// Events
export function createEvent(data: CreateEventRequest): Promise<CreateEventResponse> {
  return request<CreateEventResponse>(`${BASE_URL}/events/`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function getEvents(): Promise<EventsListResponse> {
  return request<EventsListResponse>(`${BASE_URL}/events/`);
}

// Password
export function revealPassword(data: PasswordRevealRequest): Promise<PasswordRevealResponse> {
  return request<PasswordRevealResponse>(`${BASE_URL}/password/reveal`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// Approvals
export function actionApproval(
  eventId: number,
  data: ApprovalActionRequest
): Promise<ApprovalActionResponse> {
  return request<ApprovalActionResponse>(`${BASE_URL}/approvals/${eventId}`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function getApprovals(): Promise<EventsListResponse> {
  return request<EventsListResponse>(`${BASE_URL}/approvals/`);
}

// Admin - Tenancies
export function getTenancies(): Promise<TenancyListResponse> {
  return request<TenancyListResponse>(`${BASE_URL}/admin/tenancies/`);
}

export function getTenancy(id: number): Promise<IdcsTenancy> {
  return request<IdcsTenancy>(`${BASE_URL}/admin/tenancies/${id}`);
}

export function createTenancy(data: CreateTenancyRequest): Promise<IdcsTenancy> {
  return request<IdcsTenancy>(`${BASE_URL}/admin/tenancies/`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateTenancy(id: number, data: CreateTenancyRequest): Promise<IdcsTenancy> {
  return request<IdcsTenancy>(`${BASE_URL}/admin/tenancies/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteTenancy(id: number): Promise<void> {
  return request<void>(`${BASE_URL}/admin/tenancies/${id}`, {
    method: 'DELETE',
  });
}
