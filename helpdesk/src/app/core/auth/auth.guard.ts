import { inject } from '@angular/core';
import {
  type ActivatedRouteSnapshot,
  type CanActivateFn,
  type RouterStateSnapshot,
  Router,
} from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { CurrentUserService } from './current-user.service';
import type { Role } from './current-user.model';
import { API_CONFIG } from '../http/api-config';

/**
 * Route guards enforcing which routes each role may access (design:
 * "Route guards", R1.8).
 *
 * ── UX layer, not the enforcement point ──────────────────────────────────────
 * Authorisation is enforced server-side on every endpoint; these guards are the
 * UX layer that keeps a user out of a screen they cannot use. A guard resolves
 * the {@link CurrentUserService} (loading `/auth/me` once if needed) and checks
 * the user's ADDITIVE role superset — so a person who holds several roles can
 * reach every route any of those roles grants (R1.8, roles-additive).
 */

/**
 * Ensure the current user is loaded, loading `/auth/me` on first use. Returns
 * the resolved user or `null` when unauthenticated. Because a 401 on `/auth/me`
 * is handled by the error interceptor (clears identity, no redirect), a `null`
 * result here reliably means "not logged in".
 */
async function ensureLoaded(service: CurrentUserService) {
  if (!service.loaded()) {
    try {
      await firstValueFrom(service.load());
    } catch {
      /* interceptor + service.load() already reset state; fall through. */
    }
  }
  return service.snapshot();
}

/**
 * The base guard: require an authenticated user, and optionally that the user
 * holds at least one of `allowed` roles. When `allowed` is empty any
 * authenticated user passes. On failure the user is redirected — to login when
 * unauthenticated, or to the app root when authenticated but lacking the role.
 */
function guardFor(allowed: readonly Role[]): CanActivateFn {
  return async (_route: ActivatedRouteSnapshot, _state: RouterStateSnapshot) => {
    const service = inject(CurrentUserService);
    const router = inject(Router);
    const config = inject(API_CONFIG);

    const user = await ensureLoaded(service);
    if (!user) {
      return router.parseUrl(config.loginPath);
    }

    if (allowed.length === 0 || service.hasAnyRole(allowed)) {
      return true;
    }

    // Authenticated but not permitted: bounce to the app root rather than
    // login (they are logged in). Server still enforces the real boundary.
    return router.parseUrl('/');
  };
}

/** Require an authenticated user (any role). */
export const authGuard: CanActivateFn = guardFor([]);

/**
 * Build a guard that permits the route only when the current user holds at
 * least one of the given roles (R1.8). Use in a route's `canActivate`.
 */
export function roleGuard(...allowed: Role[]): CanActivateFn {
  return guardFor(allowed);
}

/** Support screen: members of at least one team (R6.1). */
export const supportGuard: CanActivateFn = roleGuard('SUPPORT_MEMBER');

/**
 * Administer area: administrators (Tool Administrator tiles, R13.1) OR team
 * leaders (Team Leader tiles, R15.1). Fine-grained tile visibility is decided
 * inside the feature; the route is reachable by either role.
 */
export const administerGuard: CanActivateFn = roleGuard('ADMINISTRATOR', 'TEAM_LEADER');

/** Tool-administrator-only routes (R13.1, R14). */
export const adminGuard: CanActivateFn = roleGuard('ADMINISTRATOR');

/** Team-leader-only routes (R15.1, R16.1). */
export const teamLeaderGuard: CanActivateFn = roleGuard('TEAM_LEADER');
