import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { CurrentUserService } from '../auth/current-user.service';
import { API_CONFIG, isApiUrl } from './api-config';
import { ApiError } from './api-error';

/**
 * Maps failed API responses into the uniform frontend error model and handles
 * unauthenticated responses (design: "http interceptors", R1.8; "Error model",
 * R3/R5.4/R8.5/R9.7/R20).
 *
 * ── One error shape ──────────────────────────────────────────────────────────
 * The backend serialises every failure to `{ error: { code, message,
 * details? } }`. This interceptor catches any `HttpErrorResponse` for an API
 * call and rethrows it as an {@link ApiError} carrying the mapped code, message,
 * HTTP status, and details — so feature code catches ONE type and can branch on
 * a machine-readable code (INVALID_TRANSITION, MANDATORY_FIELD,
 * VALIDATION_FAILED, FORBIDDEN, CONFLICT_OPEN_REQUESTS, TIMER_MIN_DURATION).
 *
 * ── 401 → login ──────────────────────────────────────────────────────────────
 * A 401 means the session is missing/expired. The interceptor clears the cached
 * identity and routes to the login page (R1.8) — except for the `/auth/me`
 * probe itself, whose 401 is an expected "not logged in yet" signal that the
 * bootstrap/guard handles without a redirect loop. Non-API errors pass through
 * untouched.
 */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const config = inject(API_CONFIG);
  const router = inject(Router);
  const currentUser = inject(CurrentUserService);

  if (!isApiUrl(req.url, config)) {
    return next(req);
  }

  return next(req).pipe(
    catchError((err: unknown) => {
      if (!(err instanceof HttpErrorResponse)) {
        return throwError(() => err);
      }

      const apiError = ApiError.fromHttp(err.status, err.error);

      if (err.status === 401) {
        // Session missing/expired: drop the cached identity so guards fail
        // closed, then send the user to login (R1.8). The `/auth/me` probe is
        // exempt — its 401 just means "not authenticated yet", handled by the
        // bootstrap without a redirect (avoids a loop on first load).
        currentUser.clear();
        if (!req.url.endsWith('/auth/me')) {
          void router.navigate([config.loginPath]);
        }
      }

      return throwError(() => apiError);
    }),
  );
};
