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
import {
  mockAuth,
  mockTargets,
  mockApprovers,
  mockEvents,
  mockTenancies,
} from './mockData';

const BASE_URL = './ords/jit_schema/jit/v1';
const USE_MOCK = import.meta.env.DEV; // Use mock data in development mode

// OAuth2 credentials for ORDS authentication
const OAUTH_CLIENT_ID = 'uDZzGENIfEFDF3MnULXhJw..';
const OAUTH_CLIENT_SECRET = 'izOHtmHeAbsLoMFW3LGfYw..';
const TOKEN_URL = './ords/jit_schema/oauth/token';

let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const credentials = btoa(`${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`);
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    throw new Error('Failed to obtain access token');
  }

  const data = await response.json();
  cachedToken = data.access_token;
  // Expire 60 seconds early to avoid edge cases
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken!;
}

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
  const token = await getAccessToken();
  const response = await fetch(url, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
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
  if (USE_MOCK) return Promise.resolve(mockAuth);
  return request<AuthResponse>(`${BASE_URL}/auth/`);
}

// Targets
export function getTargets(): Promise<TargetResponse> {
  if (USE_MOCK) return Promise.resolve(mockTargets);
  return request<TargetResponse>(`${BASE_URL}/targets/`);
}

export function getApprovers(_type: string, _name: string): Promise<ApproverResponse> {
  if (USE_MOCK) return Promise.resolve(mockApprovers);
  return request<ApproverResponse>(
    `${BASE_URL}/targets/${encodeURIComponent(_type)}/${encodeURIComponent(_name)}/approvers`
  );
}

// Events
export function createEvent(data: CreateEventRequest): Promise<CreateEventResponse> {
  if (USE_MOCK) {
    return Promise.resolve({
      event_id: Math.floor(Math.random() * 1000) + 100,
      status: 'started',
      created_at: new Date().toISOString(),
    });
  }
  return request<CreateEventResponse>(`${BASE_URL}/events/`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function getEvents(): Promise<EventsListResponse> {
  if (USE_MOCK) return Promise.resolve(mockEvents);
  return request<EventsListResponse>(`${BASE_URL}/events/`);
}

// Password
export function revealPassword(data: PasswordRevealRequest): Promise<PasswordRevealResponse> {
  if (USE_MOCK) {
    void data;
    return Promise.resolve({
      password: 'Xk9$mP2w#Lz7!nRq4YvB',
      expires_in_minutes: 15,
    });
  }
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
  if (USE_MOCK) {
    return Promise.resolve({
      event_id: eventId,
      status: data.action === 'APPROVE' ? 'approved' : 'denied',
      actioned_at: new Date().toISOString(),
    });
  }
  return request<ApprovalActionResponse>(`${BASE_URL}/approvals/${eventId}`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function getApprovals(): Promise<EventsListResponse> {
  if (USE_MOCK) return Promise.resolve(mockEvents);
  return request<EventsListResponse>(`${BASE_URL}/approvals/`);
}

// Admin - Tenancies
export function getTenancies(): Promise<TenancyListResponse> {
  if (USE_MOCK) return Promise.resolve(mockTenancies);
  return request<TenancyListResponse>(`${BASE_URL}/admin/tenancies/`);
}

export function getTenancy(id: number): Promise<IdcsTenancy> {
  if (USE_MOCK) {
    const found = mockTenancies.items.find((t) => t.tenancy_id === id);
    return found ? Promise.resolve(found) : Promise.reject(new ApiError(404, { error: 'Not found' }));
  }
  return request<IdcsTenancy>(`${BASE_URL}/admin/tenancies/${id}`);
}

export function createTenancy(data: CreateTenancyRequest): Promise<IdcsTenancy> {
  if (USE_MOCK) {
    return Promise.resolve({
      tenancy_id: Math.floor(Math.random() * 100) + 10,
      ...data,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
  return request<IdcsTenancy>(`${BASE_URL}/admin/tenancies/`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function updateTenancy(id: number, data: CreateTenancyRequest): Promise<IdcsTenancy> {
  if (USE_MOCK) {
    return Promise.resolve({
      tenancy_id: id,
      ...data,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
  return request<IdcsTenancy>(`${BASE_URL}/admin/tenancies/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteTenancy(id: number): Promise<void> {
  if (USE_MOCK) {
    void id;
    return Promise.resolve();
  }
  return request<void>(`${BASE_URL}/admin/tenancies/${id}`, {
    method: 'DELETE',
  });
}
