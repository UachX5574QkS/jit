import { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { AuthService } from '../services/auth.service';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const userId = authService.getCurrentUserId();

  // For mutating requests, add user ID header
  if (userId !== null && req.method !== 'GET') {
    const cloned = req.clone({
      setHeaders: { 'X-User-Id': userId.toString() }
    });
    return next(cloned);
  }

  return next(req);
};
