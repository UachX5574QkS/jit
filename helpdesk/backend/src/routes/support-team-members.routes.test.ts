import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Express } from 'express';
import { errorHandler } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/current-user.js';
import { createSupportTeamMembersRouter } from './support-team-members.routes.js';
import type {
  SupportTeamMember,
  SupportTeamMembersStore,
} from './support-team-members.store.js';

/**
 * Tests for the Support team-members route layer (design: "Support side"; R7.2)
 * — the assignment drop-down source. These exercise the membership gate (a
 * member of the team can read it; a non-member is FORBIDDEN), the `:id`
 * validation, and the response envelope. The store is a hand-rolled fake so no
 * database is touched.
 */

function member(overrides: Partial<SupportTeamMember> = {}): SupportTeamMember {
  return {
    userId: 42,
    username: '20000042',
    displayName: 'Ada Lovelace',
    ...overrides,
  };
}

function fakeStore(members: SupportTeamMember[]): SupportTeamMembersStore & {
  lastTeamId: () => number | null;
} {
  let lastTeamId: number | null = null;
  return {
    listMembers: async (teamId) => {
      lastTeamId = teamId;
      return members;
    },
    lastTeamId: () => lastTeamId,
  };
}

function stubUser(teamsMemberOf: number[]): CurrentUser {
  return {
    id: 100,
    username: '11111111',
    displayName: 'Test User',
    roles: new Set(teamsMemberOf.length > 0 ? ['USER', 'SUPPORT_MEMBER'] : ['USER']),
    teamsLed: [],
    teamsMemberOf,
    isAdmin: false,
    timezone: null,
  };
}

function appWith(
  store: SupportTeamMembersStore,
  teamsMemberOf: number[] = [7, 8],
): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.currentUser = stubUser(teamsMemberOf);
    next();
  });
  app.use('/api/support', createSupportTeamMembersRouter(store));
  app.use(errorHandler);
  return app;
}

async function get(
  app: Express,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const parsed = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('GET /support/teams/:id/members (R7.2)', () => {
  it('returns the members of a team the caller belongs to', async () => {
    const store = fakeStore([
      member({ userId: 1, displayName: 'Ada Lovelace' }),
      member({ userId: 2, displayName: 'Grace Hopper' }),
    ]);
    const app = appWith(store, [7, 8]);

    const { status, body } = await get(app, '/api/support/teams/7/members');

    assert.equal(status, 200);
    assert.equal(store.lastTeamId(), 7);
    assert.deepEqual(body, {
      members: [
        { userId: 1, username: '20000042', displayName: 'Ada Lovelace' },
        { userId: 2, username: '20000042', displayName: 'Grace Hopper' },
      ],
    });
  });

  it('is FORBIDDEN for a team the caller is not a member of', async () => {
    const store = fakeStore([member()]);
    const app = appWith(store, [7, 8]);

    const { status, body } = await get(app, '/api/support/teams/99/members');

    assert.equal(status, 403);
    assert.equal((body['error'] as { code: string }).code, 'FORBIDDEN');
    // The store must never be consulted once the membership gate fails.
    assert.equal(store.lastTeamId(), null);
  });

  it('rejects a malformed team id with VALIDATION_FAILED', async () => {
    const store = fakeStore([member()]);
    const app = appWith(store, [7]);

    const { status, body } = await get(app, '/api/support/teams/abc/members');

    assert.equal(status, 400);
    assert.equal((body['error'] as { code: string }).code, 'VALIDATION_FAILED');
  });
});
