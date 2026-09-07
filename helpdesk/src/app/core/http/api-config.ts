import { InjectionToken } from '@angular/core';

/**
 * Runtime configuration for talking to the backend API.
 *
 * `baseUrl` is the prefix every backend call shares (`/api`). Only requests
 * whose URL targets this base are treated as API traffic by the interceptors —
 * that is how the auth/error interceptor knows to attach credentials and map
 * the uniform error model to those requests while leaving asset/template
 * fetches alone. `loginPath` is the client route the interceptor navigates to
 * on a 401 (R1.8).
 */
export interface ApiConfig {
  /** Shared prefix for all backend calls (default `/api`). */
  readonly baseUrl: string;
  /** Client route to send the user to when unauthenticated (default `/login`). */
  readonly loginPath: string;
}

/** The default configuration used in development and production builds. */
export const DEFAULT_API_CONFIG: ApiConfig = {
  baseUrl: '/api',
  loginPath: '/login',
};

/** DI token carrying the {@link ApiConfig}; overridable in tests. */
export const API_CONFIG = new InjectionToken<ApiConfig>('API_CONFIG', {
  providedIn: 'root',
  factory: () => DEFAULT_API_CONFIG,
});

/**
 * True when `url` targets the backend API (matches the configured `baseUrl`),
 * for both absolute (`https://host/api/...`) and root-relative (`/api/...`)
 * forms. Used by the interceptors to scope credential-attachment and error
 * mapping to API calls only.
 */
export function isApiUrl(url: string, config: ApiConfig): boolean {
  const base = config.baseUrl;
  // Root-relative: "/api" or "/api/..."
  if (url === base || url.startsWith(`${base}/`)) {
    return true;
  }
  // Absolute URL whose path starts with the base.
  try {
    const parsed = new URL(url, 'http://relative.invalid');
    return parsed.pathname === base || parsed.pathname.startsWith(`${base}/`);
  } catch {
    return false;
  }
}
