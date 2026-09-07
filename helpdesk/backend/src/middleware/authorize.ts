import type { Request, RequestHandler } from 'express';
import type { CurrentUser, Role } from '../identity/index.js';
import type { CurrentUserResolver } from '../identity/index.js';
import {
  createCurrentUserResolver,
  hasRole,
  isMemberOfTeam,
  leadsTeam,
} from '../identity/index.js';
import { ApiError } from './errors.js';

/**
 * Role-based authorisation middleware (design: cross-cutting "AuthZ", R1.8).
 *
 * ── The one rule ─────────────────────────────────────────────────────────────
 * Authorisation is derived from the ADDITIVE SUPERSET of the user's roles and
 * enforced SERVER-SIDE on EVERY endpoint. The frontend hides/reveals menus for
 * UX only; it is never the enforcement point. So every protected route runs
 * {@link authenticate} (which resolves the principal to a {@link CurrentUser}
 * and rejects unauthenticated requests with 401) and then one or more guards
 * that check the resolved role superset / team relationships.
 *
 * ── Error shape ──────────────────────────────────────────────────────────────
 * The full uniform error model and its code catalogue is task 3.8. Until then
 * these guards emit the SAME envelope every other handler uses — an
 * {@link ApiError} carried to the shared error handler, producing
 * `{ error: { code, message } }`. Authorisation failures use the `FORBIDDEN`
 * code (401 for "not authenticated", 403 for "authenticated but not allowed"),
 * so task 3.8 can build on a consistent shape rather than replace it.
 */

/**
 * Augment Express's `Request` with the resolved current user. Feature handlers
 * read `req.currentUser` and nothing else — never cookies, tokens, or the DB —
 * keeping the identity seam intact (R1.7).
 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The resolved identity, present after {@link authenticate} has run. */
      currentUser?: CurrentUser;
    }
  }
}

/** The error used when a guard is reached without a resolved user. */
function notAuthenticated(): ApiError {
  return new ApiError(401, 'FORBIDDEN', 'Authentication required');
}

/**
 * Build the authentication middleware: resolve the request to a `CurrentUser`
 * via the injected resolver and attach it as `req.currentUser`. An
 * unauthenticated request (no valid principal, or a stale session) is rejected
 * with 401 `FORBIDDEN` and never reaches downstream handlers.
 *
 * The resolver is injected so tests can supply a stub; production wiring uses
 * {@link createAuthenticate} with no argument, which builds the real resolver.
 */
export function createAuthenticate(resolver: CurrentUserResolver): RequestHandler {
  return (req, _res, next) => {
    resolver
      .resolve(req)
      .then((user) => {
        if (!user) {
          next(new ApiError(401, 'FORBIDDEN', 'Authentication required'));
          return;
        }
        req.currentUser = user;
        next();
      })
      .catch(next);
  };
}

/**
 * Production authentication middleware, wired to the real resolver (dev session
 * cookie now; IDCS later — swapped inside {@link createCurrentUserResolver}).
 * Built lazily on first use so importing this module has no side effects.
 */
let defaultAuthenticate: RequestHandler | undefined;
export const authenticate: RequestHandler = (req, res, next) => {
  if (!defaultAuthenticate) {
    defaultAuthenticate = createAuthenticate(createCurrentUserResolver());
  }
  defaultAuthenticate(req, res, next);
};

/**
 * Guard: require the current user to hold AT LEAST ONE of the given roles
 * (from the additive superset). With a single role this is "require that role";
 * with several it is an OR, matching how a screen is offered to any of the
 * roles that may use it. Denials are 403 `FORBIDDEN`.
 */
export function requireRole(...allowed: [Role, ...Role[]]): RequestHandler {
  return (req, _res, next) => {
    const user = req.currentUser;
    if (!user) {
      next(notAuthenticated());
      return;
    }
    const ok = allowed.some((role) => hasRole(user, role));
    if (!ok) {
      next(
        new ApiError(
          403,
          'FORBIDDEN',
          `Requires one of: ${allowed.join(', ')}`,
        ),
      );
      return;
    }
    next();
  };
}

/**
 * Guard: require the current user to be in the administrator group (R1.8,
 * R13.1). Equivalent to `requireRole('ADMINISTRATOR')`, named for readability
 * at the many admin-only endpoints.
 */
export const requireAdmin: RequestHandler = requireRole('ADMINISTRATOR');

/**
 * Extract a team id from the request. Reads `req.params[param]` first, falling
 * back to `req.body[param]`, and parses it as a positive integer. Returns
 * `null` when absent or malformed, which the guards treat as a 403 (the caller
 * did not identify a team they are entitled to act on).
 */
function teamIdFrom(req: Request, param: string): number | null {
  const raw =
    (req.params as Record<string, unknown>)?.[param] ??
    (req.body as Record<string, unknown> | undefined)?.[param];
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const id = Number(raw);
    if (Number.isSafeInteger(id) && id > 0) {
      return id;
    }
  }
  return null;
}

/**
 * Guard: require the current user to LEAD the team identified by the request
 * (team-leader-only actions on a specific team, R15/R16). An administrator is
 * NOT implicitly a leader here — admin endpoints are guarded separately — so
 * this checks team leadership precisely. The team id is read from the named
 * route parameter (default `teamId`), falling back to the request body.
 */
export function requireTeamLeadership(param = 'teamId'): RequestHandler {
  return (req, _res, next) => {
    const user = req.currentUser;
    if (!user) {
      next(notAuthenticated());
      return;
    }
    const teamId = teamIdFrom(req, param);
    if (teamId === null || !leadsTeam(user, teamId)) {
      next(
        new ApiError(403, 'FORBIDDEN', 'Requires leadership of this team'),
      );
      return;
    }
    next();
  };
}

/**
 * Guard: require the current user to be a MEMBER of the team identified by the
 * request (support actions scoped to a team the member belongs to, R6/R7). The
 * team id is read from the named route parameter (default `teamId`), falling
 * back to the request body.
 */
export function requireTeamMembership(param = 'teamId'): RequestHandler {
  return (req, _res, next) => {
    const user = req.currentUser;
    if (!user) {
      next(notAuthenticated());
      return;
    }
    const teamId = teamIdFrom(req, param);
    if (teamId === null || !isMemberOfTeam(user, teamId)) {
      next(
        new ApiError(403, 'FORBIDDEN', 'Requires membership of this team'),
      );
      return;
    }
    next();
  };
}
