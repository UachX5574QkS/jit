import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  createAuthRouter,
  createLoginHandler,
  createLogoutHandler,
  createMeHandler,
  createUsersHandler,
  serializeCurrentUser,
  type AuthRouterDeps,
} from './auth.routes.js';
import { createAuthenticate } from '../middleware/authorize.js';
import { ApiError } from '../middleware/errors.js';
import { CurrentUserResolver } from '../identity/resolver.js';
import { DevSessionAuthSource } from '../identity/auth-source.js';
import type { CredentialLoader } from '../identity/credential-loader.js';
import type { UserIdentityLoader } from '../identity/identity-loader.js';
import type {
  DirectoryUser,
  UserDirectoryLoader,
} from '../identity/user-directory.js';
import { buildCurrentUser, type Role, type UserIdentity } from '../identity/current-user.js';
import { hashPassword } from '../security/password.js';
import { config } from '../config/env.js';

/**
 * Tests for the auth endpoints (design: "Auth & identity", R1.1, R1.3, R1.4,
 * R1.7). Handlers are invoked directly with fake req/res/next — no HTTP server,
 * no database — matching the project's injectable, DB-free unit-test style. The
 * credential loader and identity loader are in-memory fakes; the resolver and
 * DevSessionAuthSource are the real ones, so the login→cookie→/me round-trip is
 * exercised end to end (including the actual signed-cookie contract).
 */

/** A minimal identity; override fields per test. */
function identity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    id: 1,
    username: '11111111',
    firstName: 'Jason',
    surname: 'Hughes',
    timezone: null,
    teamsLed: [],
    teamsMemberOf: [],
    isAdmin: false,
    ...overrides,
  };
}

/** An in-memory credential loader keyed by username. */
function fakeCredentialLoader(
  byUsername: Record<string, { id: number; passwordHash: string }>,
): CredentialLoader {
  return {
    loadByUsername: async (username) => byUsername[username] ?? null,
  };
}

/** An in-memory identity loader keyed by principal id. */
function fakeIdentityLoader(byId: Record<number, UserIdentity>): UserIdentityLoader {
  return { load: async (id) => byId[id] ?? null };
}

/** Build a directory user with the given roles (USER is implied elsewhere). */
function directoryUser(
  username: string,
  firstName: string,
  surname: string,
  ...roleList: Role[]
): DirectoryUser {
  return { username, firstName, surname, roles: new Set<Role>(['USER', ...roleList]) };
}

/** An in-memory directory loader returning a fixed list. */
function fakeDirectoryLoader(users: DirectoryUser[]): UserDirectoryLoader {
  return { loadAll: async () => users };
}

/**
 * Find the layer registered on an Express router for `method` + `path` by
 * inspecting the router stack, so a test can assert whether `/users` is mounted
 * without spinning up an HTTP server.
 */
function routeHandler(
  router: ReturnType<typeof createAuthRouter>,
  method: string,
  path: string,
): ((req: Request, res: Response, next: (err?: unknown) => void) => void) | null {
  const stack = (router as unknown as { stack: Array<Record<string, unknown>> }).stack;
  for (const layer of stack) {
    const route = layer['route'] as
      | { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> }
      | undefined;
    if (route && route.path === path && route.methods[method.toLowerCase()]) {
      return route.stack[route.stack.length - 1].handle as never;
    }
  }
  return null;
}

/**
 * A fake response that records status, JSON body, and cookie operations. The
 * cookie recording mirrors what `res.cookie`/`res.clearCookie` would do so a
 * test can inspect the established/cleared session cookie. A terminal
 * `end()`/`json()` fires the `onDone` callback so the test can await the
 * response, regardless of how long the handler's async work (e.g. bcrypt) took.
 */
interface FakeRes {
  statusCode?: number;
  body?: unknown;
  ended: boolean;
  cookies: Record<string, { value: string; options: Record<string, unknown> }>;
  cleared: Record<string, Record<string, unknown>>;
  res: Response;
  onDone?: () => void;
}

function fakeResponse(): FakeRes {
  const state: FakeRes = {
    ended: false,
    cookies: {},
    cleared: {},
    res: undefined as unknown as Response,
  };
  const done = () => state.onDone?.();
  state.res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      done();
      return this;
    },
    end() {
      state.ended = true;
      done();
      return this;
    },
    cookie(name: string, value: string, options: Record<string, unknown>) {
      state.cookies[name] = { value, options };
      return this;
    },
    clearCookie(name: string, options: Record<string, unknown>) {
      state.cleared[name] = options;
      return this;
    },
  } as unknown as Response;
  return state;
}

/**
 * Invoke a handler and settle when it either calls `next` (returning the error,
 * or `undefined` for a bare `next()`), or terminates the response via
 * `json()`/`end()` — whichever happens first. This awaits the handler's async
 * work (including bcrypt) rather than a fixed number of ticks.
 */
function invoke(
  handler: (req: Request, res: Response, next: (err?: unknown) => void) => void,
  req: Partial<Request>,
  fake: FakeRes,
): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (err: unknown) => {
      if (!settled) {
        settled = true;
        resolve(err);
      }
    };
    fake.onDone = () => settle(undefined);
    handler(req as Request, fake.res, (err?: unknown) => settle(err));
  });
}

const COOKIE = config.session.cookieName;
let passwordHash: string;

before(async () => {
  passwordHash = await hashPassword('password1');
});

describe('POST /auth/login', () => {
  it('sets the signed HTTP-only session cookie on valid credentials (R1.3)', async () => {
    const loader = fakeCredentialLoader({ '11111111': { id: 42, passwordHash } });
    const res = fakeResponse();
    await invoke(
      createLoginHandler(loader),
      { body: { username: '11111111', password: 'password1' } },
      res,
    );

    assert.equal(res.statusCode, 204);
    assert.ok(res.cookies[COOKIE], 'session cookie should be set');
    assert.equal(res.cookies[COOKIE].value, '42');
    const opts = res.cookies[COOKIE].options;
    assert.equal(opts['httpOnly'], true);
    assert.equal(opts['signed'], true);
    assert.equal(opts['sameSite'], 'lax');
  });

  it('rejects invalid password without establishing a session (R1.4)', async () => {
    const loader = fakeCredentialLoader({ '11111111': { id: 42, passwordHash } });
    const res = fakeResponse();
    const err = await invoke(
      createLoginHandler(loader),
      { body: { username: '11111111', password: 'wrong' } },
      res,
    );

    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).status, 401);
    assert.equal((err as ApiError).code, 'FORBIDDEN');
    assert.deepEqual(res.cookies, {}, 'no session cookie may be set on failure');
  });

  it('rejects an unknown username identically (no account disclosure, R1.4)', async () => {
    const loader = fakeCredentialLoader({ '11111111': { id: 42, passwordHash } });
    const res = fakeResponse();
    const err = await invoke(
      createLoginHandler(loader),
      { body: { username: '99999999', password: 'password1' } },
      res,
    );

    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).status, 401);
    assert.equal((err as ApiError).code, 'FORBIDDEN');
    assert.deepEqual(res.cookies, {});
  });

  it('never returns or echoes the password/hash in the rejection', async () => {
    const loader = fakeCredentialLoader({ '11111111': { id: 42, passwordHash } });
    const res = fakeResponse();
    const err = await invoke(
      createLoginHandler(loader),
      { body: { username: '11111111', password: 'wrong' } },
      res,
    );
    const serialised = JSON.stringify({ err, body: res.body });
    assert.equal(serialised.includes(passwordHash), false);
    assert.equal(serialised.includes('wrong'), false);
  });

  it('rejects a malformed body with VALIDATION_FAILED', async () => {
    const loader = fakeCredentialLoader({});
    for (const body of [{}, { username: '11111111' }, { username: '', password: 'x' }]) {
      const res = fakeResponse();
      const err = await invoke(createLoginHandler(loader), { body }, res);
      assert.ok(err instanceof ApiError, JSON.stringify(body));
      assert.equal((err as ApiError).code, 'VALIDATION_FAILED');
      assert.deepEqual(res.cookies, {});
    }
  });
});

describe('POST /auth/logout', () => {
  it('clears the session cookie', async () => {
    const res = fakeResponse();
    await invoke(createLogoutHandler(), { body: {} }, res);
    assert.equal(res.statusCode, 204);
    assert.ok(res.cleared[COOKIE], 'session cookie should be cleared');
  });
});

describe('GET /auth/me', () => {
  it('returns the resolved CurrentUser view when authenticated', async () => {
    const user = buildCurrentUser(
      identity({ id: 42, teamsLed: [3], teamsMemberOf: [3, 5], isAdmin: true }),
    );
    const res = fakeResponse();
    await invoke(createMeHandler(), { currentUser: user }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, serializeCurrentUser(user));
    const body = res.body as ReturnType<typeof serializeCurrentUser>;
    assert.equal(body.id, 42);
    assert.equal(body.isAdmin, true);
    assert.deepEqual(body.roles.sort(), [
      'ADMINISTRATOR',
      'SUPPORT_MEMBER',
      'TEAM_LEADER',
      'USER',
    ]);
    assert.deepEqual(body.teamsLed, [3]);
    assert.deepEqual(body.teamsMemberOf, [3, 5]);
  });

  it('401s when unauthenticated (authenticate middleware rejects first)', async () => {
    // Empty auth source → resolver returns null → authenticate emits 401.
    const resolver = new CurrentUserResolver(
      { resolvePrincipalId: () => null },
      fakeIdentityLoader({}),
    );
    const authenticate = createAuthenticate(resolver);
    const res = fakeResponse();
    const err = await invoke(authenticate, { signedCookies: {} }, res);

    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).status, 401);
    assert.equal((err as ApiError).code, 'FORBIDDEN');
  });
});

describe('login → cookie → /me round-trip (real signed-cookie contract, R1.3/R1.7)', () => {
  it('the cookie value written on login is what DevSessionAuthSource reads back', async () => {
    // 1. Log in and capture the cookie value the handler wrote.
    const loader = fakeCredentialLoader({ '11111111': { id: 42, passwordHash } });
    const loginRes = fakeResponse();
    await invoke(
      createLoginHandler(loader),
      { body: { username: '11111111', password: 'password1' } },
      loginRes,
    );
    const cookieValue = loginRes.cookies[COOKIE].value;

    // 2. Feed that value back as a verified signed cookie (cookie-parser would
    //    place the verified value on req.signedCookies) and resolve /me.
    const resolver = new CurrentUserResolver(
      new DevSessionAuthSource(COOKIE),
      fakeIdentityLoader({ 42: identity({ id: 42 }) }),
    );
    const authenticate = createAuthenticate(resolver);
    const req: Partial<Request> = { signedCookies: { [COOKIE]: cookieValue } };
    const authErr = await invoke(authenticate, req, fakeResponse());
    assert.equal(authErr, undefined, 'authenticate should accept the session');
    assert.ok(req.currentUser);
    assert.equal(req.currentUser.id, 42);

    // 3. /me returns the resolved user.
    const meRes = fakeResponse();
    await invoke(createMeHandler(), req, meRes);
    assert.equal(meRes.statusCode, 200);
    assert.equal((meRes.body as { id: number }).id, 42);
  });
});

describe('GET /auth/users (dev-only login drop-down, R1.2)', () => {
  it('returns the formatted list with the highest-privilege role per person', async () => {
    const loader = fakeDirectoryLoader([
      directoryUser('11111111', 'Jason', 'Hughes', 'ADMINISTRATOR'),
      directoryUser('22222222', 'Amy', 'Smith', 'SUPPORT_MEMBER', 'TEAM_LEADER'),
      directoryUser('33333333', 'Ravi', 'Patel'),
    ]);
    const res = fakeResponse();
    await invoke(createUsersHandler(loader), {}, res);

    assert.equal(res.statusCode, 200);
    const body = res.body as { users: Array<Record<string, string>> };
    assert.equal(body.users.length, 3);

    // Highest-privilege role selection drives both `role` and `label` (R1.2).
    assert.equal(body.users[0].role, 'ADMINISTRATOR');
    assert.equal(body.users[0].label, '11111111 Jason (Administrator) Hughes');
    assert.equal(body.users[1].role, 'TEAM_LEADER');
    assert.equal(body.users[1].label, '22222222 Amy (Team Leader) Smith');
    assert.equal(body.users[2].role, 'USER');
    assert.equal(body.users[2].label, '33333333 Ravi (User) Patel');

    // Raw fields are present for the frontend; no password material is exposed.
    assert.deepEqual(body.users[0], {
      username: '11111111',
      firstName: 'Jason',
      surname: 'Hughes',
      role: 'ADMINISTRATOR',
      label: '11111111 Jason (Administrator) Hughes',
    });
    assert.equal(JSON.stringify(body).toLowerCase().includes('password'), false);
  });

  it('mounts GET /users when the runtime is development', () => {
    const deps: AuthRouterDeps = {
      credentialLoader: fakeCredentialLoader({}),
      resolver: new CurrentUserResolver({ resolvePrincipalId: () => null }, fakeIdentityLoader({})),
      userDirectoryLoader: fakeDirectoryLoader([]),
      isDevelopment: true,
    };
    const router = createAuthRouter(deps);
    assert.ok(routeHandler(router, 'GET', '/users'), '/users should be mounted in development');
  });

  it('does NOT mount GET /users outside development', () => {
    const deps: AuthRouterDeps = {
      credentialLoader: fakeCredentialLoader({}),
      resolver: new CurrentUserResolver({ resolvePrincipalId: () => null }, fakeIdentityLoader({})),
      userDirectoryLoader: fakeDirectoryLoader([]),
      isDevelopment: false,
    };
    const router = createAuthRouter(deps);
    assert.equal(
      routeHandler(router, 'GET', '/users'),
      null,
      '/users must not be exposed outside development',
    );
    // The other auth routes remain regardless of environment.
    assert.ok(routeHandler(router, 'POST', '/login'));
    assert.ok(routeHandler(router, 'GET', '/me'));
  });
});
