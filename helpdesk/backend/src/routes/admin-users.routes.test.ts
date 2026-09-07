import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Express } from 'express';
import {
  createAdminUsersRouter,
  serializeAdminUser,
} from './admin-users.routes.js';
import type { AdminUser, AdminUsersStore } from './admin-users.store.js';
import { ApiError } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/index.js';

/**
 * Tests for `GET /api/admin/users` — the leader-picker source for the
 * Tool-Administrator Teams screen (R13.2/13.3, admin-only R13.1).
 */

function fakeStore(users: AdminUser[]): AdminUsersStore {
  return { list: async () => users };
}

/** A minimal current-user with the given roles for the auth stub. */
function userWithRoles(roles: string[]): CurrentUser {
  return {
    id: 1,
    username: '11111111',
    displayName: 'Test User',
    roles: new Set(roles),
    teamsLed: [],
    teamsMemberOf: [],
    isAdmin: roles.includes('ADMINISTRATOR'),
    timezone: null,
  } as unknown as CurrentUser;
}

/**
 * Build an app that stubs `req.currentUser` (as the global authenticate would)
 * then mounts the admin-users router, so its `requireAdmin` guard runs for real.
 */
function appAs(roles: string[], store: AdminUsersStore): Express {
  const app = express();
  app.use((req, _res, next) => {
    req.currentUser = userWithRoles(roles);
    next();
  });
  app.use('/admin/users', createAdminUsersRouter(store));
  // Minimal error handler mirroring the uniform envelope.
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (err instanceof ApiError) {
        res.status(err.status).json({ error: { code: err.code, message: err.message } });
        return;
      }
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'boom' } });
    },
  );
  return app;
}

async function get(app: Express, path: string) {
  // Use a lightweight fetch against a listening server.
  const server = app.listen(0);
  try {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  } finally {
    server.close();
  }
}

describe('serializeAdminUser', () => {
  it('maps a stored user to its public id/username/displayName view', () => {
    const view = serializeAdminUser({ id: 7, username: '22222222', displayName: 'Ada Lovelace' });
    assert.deepEqual(view, { id: 7, username: '22222222', displayName: 'Ada Lovelace' });
  });
});

describe('GET /admin/users (admin-only, R13.1)', () => {
  it('returns the list of people for an administrator', async () => {
    const store = fakeStore([
      { id: 3, username: '33333333', displayName: 'Grace Hopper' },
      { id: 4, username: '44444444', displayName: 'Alan Turing' },
    ]);
    const { status, body } = await get(appAs(['ADMINISTRATOR', 'USER'], store), '/admin/users');
    assert.equal(status, 200);
    assert.deepEqual(body, {
      users: [
        { id: 3, username: '33333333', displayName: 'Grace Hopper' },
        { id: 4, username: '44444444', displayName: 'Alan Turing' },
      ],
    });
  });

  it('rejects a non-administrator with FORBIDDEN', async () => {
    const store = fakeStore([]);
    const { status, body } = await get(appAs(['USER'], store), '/admin/users');
    assert.equal(status, 403);
    assert.equal((body as { error: { code: string } }).error.code, 'FORBIDDEN');
  });
});
