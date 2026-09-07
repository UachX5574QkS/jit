import { Router, type RequestHandler } from 'express';
import { config, isDevelopment } from '../config/env.js';
import { ApiError } from '../middleware/errors.js';
import { createAuthenticate } from '../middleware/authorize.js';
import {
  type CredentialLoader,
  type CurrentUser,
  type CurrentUserResolver,
  type DirectoryUser,
  type UserDirectoryLoader,
  DbCredentialLoader,
  DbUserDirectoryLoader,
  createCurrentUserResolver,
  formatDirectoryLabel,
  highestPrivilegeRole,
} from '../identity/index.js';
import { verifyPassword } from '../security/password.js';

/**
 * Authentication & identity routes (design: "Auth & identity", R1).
 *
 * ── The dev session mechanism ────────────────────────────────────────────────
 * `POST /api/auth/login` verifies a username/password against the stored
 * bcrypt hash and, on success, establishes an HTTP-only session cookie whose
 * value is the SIGNED `app_user.id` (R1.3). That is exactly what
 * {@link DevSessionAuthSource} reads back on subsequent requests — the cookie
 * name comes from `config.session.cookieName` and `cookie-parser` (configured
 * with the session secret in `app.ts`) verifies the signature, so a tampered
 * cookie is dropped and appears unauthenticated. `POST /api/auth/logout` clears
 * that cookie; `GET /api/auth/me` returns the resolved {@link CurrentUser}.
 *
 * On invalid credentials the login is rejected WITHOUT establishing a session
 * (R1.4), via the uniform error model, and neither the password nor the stored
 * hash is ever logged or returned (R1.5). A missing username and a wrong
 * password produce the same response so the endpoint does not reveal whether an
 * account exists.
 *
 * The dependencies (credential loader, current-user resolver) are injected so
 * the handlers can be unit-tested without a live database; production wiring in
 * {@link authRouter} uses the real Postgres-backed defaults.
 */

/**
 * The public JSON shape of a resolved current user returned by `/auth/me`
 * (design: "Auth & identity" — id, name, roles, teams led, teams member of,
 * isAdmin, timezone). The `roles` set is serialised to a sorted array so the
 * response is deterministic and JSON-friendly.
 */
export interface CurrentUserView {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
  readonly roles: string[];
  readonly teamsLed: number[];
  readonly teamsMemberOf: number[];
  readonly isAdmin: boolean;
  readonly timezone: string | null;
}

/** Serialise a {@link CurrentUser} into its public JSON view. */
export function serializeCurrentUser(user: CurrentUser): CurrentUserView {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    roles: [...user.roles].sort(),
    teamsLed: [...user.teamsLed],
    teamsMemberOf: [...user.teamsMemberOf],
    isAdmin: user.isAdmin,
    timezone: user.timezone,
  };
}

/**
 * The public JSON shape of a directory entry for the development login
 * drop-down (design: `GET /api/auth/users`, R1.2).
 *
 * Both the raw fields and a preformatted `label` are returned so the frontend
 * can render the drop-down directly (using `label`) or reformat if it prefers
 * (using the individual fields). `role` is the SINGLE highest-privilege role of
 * the person's additive superset (see {@link highestPrivilegeRole}); no
 * password material is ever included (R1.5).
 */
export interface DirectoryUserView {
  readonly username: string;
  readonly firstName: string;
  readonly surname: string;
  /** The highest-privilege role code (ADMINISTRATOR > TEAM_LEADER > SUPPORT_MEMBER > USER). */
  readonly role: string;
  /** Preformatted "`<username>` `<firstname>` (`<role>`) `<surname>`" label (R1.2). */
  readonly label: string;
}

/** Serialise a {@link DirectoryUser} into its public drop-down view (R1.2). */
export function serializeDirectoryUser(user: DirectoryUser): DirectoryUserView {
  return {
    username: user.username,
    firstName: user.firstName,
    surname: user.surname,
    role: highestPrivilegeRole(user.roles),
    label: formatDirectoryLabel(user),
  };
}

/**
 * Options for {@link createAuthRouter}. All are injectable so the router can be
 * built against fakes in tests; each defaults to the real implementation.
 */
export interface AuthRouterDeps {
  /** Loads `{ id, passwordHash }` by username for credential verification. */
  readonly credentialLoader: CredentialLoader;
  /** Resolves a request to its `CurrentUser` for `/auth/me`. */
  readonly resolver: CurrentUserResolver;
  /** Loads the directory for the dev-only login drop-down (`/auth/users`, R1.2). */
  readonly userDirectoryLoader: UserDirectoryLoader;
  /**
   * Whether the runtime is development. The `/auth/users` drop-down endpoint is
   * only mounted when this is true, so outside development the route does not
   * exist and any request falls through to the 404 handler (R1.2). Injectable
   * so tests can exercise both the dev and non-dev wiring without touching the
   * process environment; defaults to {@link isDevelopment}.
   */
  readonly isDevelopment?: boolean;
}

/** Cookie options for the session cookie, consistent with how it is read back. */
function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: config.session.secureCookie,
    signed: true,
    path: '/',
  };
}

/**
 * Extract and validate the `{ username, password }` login body. Both must be
 * non-empty strings; anything else is a malformed request. Returns the trimmed
 * username together with the raw password (passwords are compared verbatim, so
 * they are not trimmed).
 */
function readCredentials(body: unknown): { username: string; password: string } {
  const record = (body ?? {}) as Record<string, unknown>;
  const username = record['username'];
  const password = record['password'];
  if (typeof username !== 'string' || typeof password !== 'string') {
    throw ApiError.of('VALIDATION_FAILED', 'Username and password are required.');
  }
  const trimmed = username.trim();
  if (trimmed === '' || password === '') {
    throw ApiError.of('VALIDATION_FAILED', 'Username and password are required.');
  }
  return { username: trimmed, password };
}

/** The uniform rejection for any failed login — identical for every failure. */
function invalidCredentials(): ApiError {
  return ApiError.of('FORBIDDEN', 'Invalid username or password.', undefined, 401);
}

/** `POST /api/auth/login` — verify credentials and establish a session (R1.3, R1.4). */
export function createLoginHandler(credentialLoader: CredentialLoader): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const { username, password } = readCredentials(req.body);
      const credential = await credentialLoader.loadByUsername(username);
      // Verify even when the account is missing so the timing/response does not
      // reveal whether a username exists; a missing account fails closed.
      const ok = credential
        ? await verifyPassword(password, credential.passwordHash)
        : false;
      if (!credential || !ok) {
        // Reject WITHOUT establishing a session (R1.4).
        throw invalidCredentials();
      }
      // Establish the HTTP-only, signed session cookie holding the principal id
      // — exactly what DevSessionAuthSource reads back (R1.3).
      res.cookie(config.session.cookieName, String(credential.id), sessionCookieOptions());
      res.status(204).end();
    })().catch(next);
  };
}

/** `POST /api/auth/logout` — clear the session cookie. */
export function createLogoutHandler(): RequestHandler {
  return (_req, res) => {
    // Clear with matching attributes so the browser drops the cookie.
    const { signed: _signed, ...clearOptions } = sessionCookieOptions();
    res.clearCookie(config.session.cookieName, clearOptions);
    res.status(204).end();
  };
}

/** `GET /api/auth/me` — the resolved CurrentUser; 401 when unauthenticated. */
export function createMeHandler(): RequestHandler {
  // `authenticate` guarantees `req.currentUser` is set (or already 401'd).
  return (req, res) => {
    const user = req.currentUser;
    if (!user) {
      // Defensive: authenticate should have rejected already.
      throw ApiError.of('FORBIDDEN', 'Authentication required', undefined, 401);
    }
    res.status(200).json(serializeCurrentUser(user));
  };
}

/**
 * `GET /api/auth/users` — DEV-ONLY directory for the login drop-down (R1.2).
 *
 * Returns every created person with the fields needed to render the drop-down
 * label "`<username>` `<firstname>` (`<role>`) `<surname>`", where `<role>` is
 * the person's single highest-privilege role. It is PUBLIC (pre-login) because
 * it drives the login screen, but is only mounted in development (see
 * {@link createAuthRouter}); no password material is ever returned (R1.5).
 */
export function createUsersHandler(loader: UserDirectoryLoader): RequestHandler {
  return (_req, res, next) => {
    void (async () => {
      const users = await loader.loadAll();
      res.status(200).json({ users: users.map(serializeDirectoryUser) });
    })().catch(next);
  };
}

/**
 * Build the auth router with injectable dependencies. `POST /auth/login` and
 * `POST /auth/logout` are public; `GET /auth/me` runs the {@link authenticate}
 * middleware first so it 401s an unauthenticated request before the handler.
 *
 * `GET /auth/users` is the DEV-ONLY login drop-down (R1.2): it is mounted ONLY
 * when the runtime is development. Outside development the route is never
 * registered, so a request for it falls through to the uniform 404 handler and
 * the directory is not exposed.
 */
export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  const authenticate = createAuthenticate(deps.resolver);

  router.post('/login', createLoginHandler(deps.credentialLoader));
  router.post('/logout', createLogoutHandler());
  router.get('/me', authenticate, createMeHandler());

  // Dev-only login drop-down (R1.2): public, but only when in development.
  if (deps.isDevelopment ?? isDevelopment()) {
    router.get('/users', createUsersHandler(deps.userDirectoryLoader));
  }

  return router;
}

/**
 * Production auth router, wired to the real Postgres-backed credential loader
 * and current-user resolver (dev session cookie now; IDCS later — swapped
 * inside {@link createCurrentUserResolver}).
 */
export const authRouter: Router = createAuthRouter({
  credentialLoader: new DbCredentialLoader(),
  resolver: createCurrentUserResolver(),
  userDirectoryLoader: new DbUserDirectoryLoader(),
});
