import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { API_CONFIG, isApiUrl } from './api-config';

/**
 * Attaches session credentials to backend API calls (design:
 * "http interceptors", R1.8).
 *
 * The development backend authenticates with an HTTP-only, signed session
 * cookie set by `POST /api/auth/login`. The browser only sends that cookie on
 * cross-context XHR/fetch when `withCredentials` is set, so this interceptor
 * flips it on for every request that targets the API base (`/api`). Non-API
 * requests (asset/template fetches) are left untouched.
 *
 * ── Ready for IDCS ───────────────────────────────────────────────────────────
 * The abstraction point is here: today the credential is a cookie, so only
 * `withCredentials` is needed. A future IDCS deployment can attach a bearer
 * token in this same interceptor without touching feature code (R1.7/R1.8).
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const config = inject(API_CONFIG);

  if (!isApiUrl(req.url, config)) {
    return next(req);
  }

  return next(req.clone({ withCredentials: true }));
};
