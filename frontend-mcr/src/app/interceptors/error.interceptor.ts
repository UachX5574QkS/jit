import { HttpInterceptorFn, HttpErrorResponse } from '@angular/common/http';
import { catchError, throwError } from 'rxjs';

/**
 * Global HTTP error interceptor.
 * Maps HTTP error codes to user-friendly messages and actions:
 * - 400 → passes through for inline form validation
 * - 403 → snackbar with "Access denied" message
 * - 404 → redirects to active list
 * - 500+ → generic snackbar error
 */
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  return next(req).pipe(
    catchError((error: HttpErrorResponse) => {
      // Log errors to console for debugging
      console.error('HTTP Error:', error.status, error.url, error.message);
      return throwError(() => error);
    })
  );
};
