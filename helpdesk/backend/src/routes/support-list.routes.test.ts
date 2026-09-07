import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Express } from 'express';
import { ApiError, errorHandler } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/current-user.js';
import {
  createSupportListRouter,
  parseHideComplete,
  parseScope,
  parseSearch,
  parseShowUnassigned,
  parseTeam,
  resolveTeamScope,
} from './support-list.routes.js';
import type {
  SupportListQuery,
  SupportListRow,
  SupportListStore,
  SupportListViewer,
} from './support-list.store.js';

/**
 * Tests for the Support-list route layer (design: "Support side" —
 * `GET /api/support/requests?team=&scope=mine|team&hideComplete=&
 * showUnassigned=&q=`; R6). These exercise query-string parsing, the team
 * drop-down membership rules (all vs a specific team; non-member → FORBIDDEN;
 * no-teams user → empty list), the viewer identity coming from
 * `req.currentUser`, the response envelope, and the defaults (team=all,
 * scope=mine, hideComplete=true, showUnassigned=true). The store is a
 * hand-rolled fake so no database is touched — matching the injectable-store
 * route style.
 */

function row(overrides: Partial<SupportListRow> = {}): SupportListRow {
  return {
    id: 555,
    taskReference: 'REQ-ABC-000001',
    jiraNumber: 'J-1',
    title: 'Broken printer',
    dateRaised: '2026-02-01T09:00:00.000Z',
    status: 'NEW',
    teamId: 7,
    teamTitle: 'Platform',
    assignedMemberId: null,
    assignedMemberName: null,
    lastUpdated: '2026-02-02T10:30:00.000Z',
    estimatedStartDate: null,
    actualStartDate: null,
    hasOpenTimer: false,
    estimatedEffortMinutes: null,
    updatedSinceLastSeen: false,
    ...overrides,
  };
}

/** A fake store that records the query + viewer it was called with. */
function fakeStore(
  rows: SupportListRow[],
): SupportListStore & {
  last: () => { query: SupportListQuery; viewer: SupportListViewer } | null;
  called: () => boolean;
} {
  let last: { query: SupportListQuery; viewer: SupportListViewer } | null = null;
  return {
    list: async (query, viewer) => {
      last = { query, viewer };
      return rows;
    },
    last: () => last,
    called: () => last !== null,
  };
}

function stubUser(id: number, teamsMemberOf: number[]): CurrentUser {
  return {
    id,
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
  store: SupportListStore,
  opts: { userId?: number; teamsMemberOf?: number[] } = {},
): Express {
  const { userId = 100, teamsMemberOf = [7, 8] } = opts;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.currentUser = stubUser(userId, teamsMemberOf);
    next();
  });
  app.use('/api/support', createSupportListRouter(store));
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

// ── Query parsing (unit) ─────────────────────────────────────────────────────────

describe('parseTeam (R6.3)', () => {
  it('defaults to "all" when absent or blank', () => {
    assert.equal(parseTeam(undefined), 'all');
    assert.equal(parseTeam(''), 'all');
  });
  it('accepts "all" (case-insensitive) and a positive team id', () => {
    assert.equal(parseTeam('all'), 'all');
    assert.equal(parseTeam('ALL'), 'all');
    assert.equal(parseTeam('7'), 7);
  });
  it('rejects a non-numeric, non-"all" value with VALIDATION_FAILED', () => {
    assert.throws(
      () => parseTeam('platform'),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });
});

describe('parseScope (R6.4)', () => {
  it('defaults to "mine" when absent or blank', () => {
    assert.equal(parseScope(undefined), 'mine');
    assert.equal(parseScope(''), 'mine');
  });
  it('accepts "mine" and "team"', () => {
    assert.equal(parseScope('mine'), 'mine');
    assert.equal(parseScope('team'), 'team');
  });
  it('rejects an unknown scope with VALIDATION_FAILED', () => {
    assert.throws(
      () => parseScope('everything'),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });
});

describe('parseHideComplete / parseShowUnassigned (R6.5, R6.6)', () => {
  it('both default to true when absent', () => {
    assert.equal(parseHideComplete(undefined), true);
    assert.equal(parseShowUnassigned(undefined), true);
  });
  it('parse truthy and falsy spellings', () => {
    assert.equal(parseHideComplete('false'), false);
    assert.equal(parseHideComplete('0'), false);
    assert.equal(parseShowUnassigned('false'), false);
    assert.equal(parseShowUnassigned('FALSE'), false);
    assert.equal(parseShowUnassigned('1'), true);
  });
  it('reject a non-boolean value', () => {
    assert.throws(
      () => parseHideComplete('maybe'),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
    assert.throws(
      () => parseShowUnassigned('maybe'),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });
});

describe('parseSearch (R6.2)', () => {
  it('trims and returns the term, or null when blank/absent', () => {
    assert.equal(parseSearch('  printer '), 'printer');
    assert.equal(parseSearch('   '), null);
    assert.equal(parseSearch(undefined), null);
  });
});

// ── resolveTeamScope: the team drop-down membership rules (R6.3) ─────────────────

describe('resolveTeamScope (R6.3)', () => {
  it('"all" resolves to every team the user is a member of', () => {
    assert.deepEqual(resolveTeamScope('all', stubUser(100, [7, 8])), [7, 8]);
  });
  it('"all" resolves to an empty scope for a user in no teams', () => {
    assert.deepEqual(resolveTeamScope('all', stubUser(100, [])), []);
  });
  it('a specific team the user is a member of resolves to that one team', () => {
    assert.deepEqual(resolveTeamScope(7, stubUser(100, [7, 8])), [7]);
  });
  it('a specific team the user is NOT a member of is FORBIDDEN', () => {
    assert.throws(
      () => resolveTeamScope(9, stubUser(100, [7, 8])),
      (e) => e instanceof ApiError && e.code === 'FORBIDDEN',
    );
  });
  it('any specific team is FORBIDDEN for a user in no teams', () => {
    assert.throws(
      () => resolveTeamScope(7, stubUser(100, [])),
      (e) => e instanceof ApiError && e.code === 'FORBIDDEN',
    );
  });
});

// ── GET /api/support/requests (integration through the router) ──────────────────

describe('GET /api/support/requests (R6)', () => {
  it('defaults to team=all, scope=mine, hideComplete=true, showUnassigned=true, no search', async () => {
    const store = fakeStore([row()]);
    const app = appWith(store, { userId: 100, teamsMemberOf: [7, 8] });

    const res = await get(app, '/api/support/requests');

    assert.equal(res.status, 200);
    assert.deepEqual(store.last()?.query, {
      scope: 'mine',
      hideComplete: true,
      showUnassigned: true,
      search: null,
    });
    // The team scope is derived from CurrentUser.teamsMemberOf, not the query.
    assert.deepEqual(store.last()?.viewer, { userId: 100, teamIds: [7, 8] });
    assert.equal(res.body['team'], 'all');
    assert.equal(res.body['scope'], 'mine');
    assert.equal(res.body['hideComplete'], true);
    assert.equal(res.body['showUnassigned'], true);
    assert.equal(res.body['search'], null);
    assert.equal((res.body['requests'] as unknown[]).length, 1);
  });

  it('passes a specific membership-checked team and the toggles through', async () => {
    const store = fakeStore([]);
    const app = appWith(store, { userId: 100, teamsMemberOf: [7, 8] });

    const res = await get(
      app,
      '/api/support/requests?team=7&scope=team&hideComplete=false&showUnassigned=false&q=toner',
    );

    assert.equal(res.status, 200);
    assert.deepEqual(store.last()?.query, {
      scope: 'team',
      hideComplete: false,
      showUnassigned: false,
      search: 'toner',
    });
    assert.deepEqual(store.last()?.viewer, { userId: 100, teamIds: [7] });
    assert.equal(res.body['team'], 7);
  });

  it('rejects a team the caller is not a member of with 403 FORBIDDEN', async () => {
    const store = fakeStore([]);
    const app = appWith(store, { userId: 100, teamsMemberOf: [7, 8] });

    const res = await get(app, '/api/support/requests?team=9');

    assert.equal(res.status, 403);
    assert.equal((res.body['error'] as Record<string, unknown>)['code'], 'FORBIDDEN');
    // The store is never consulted for a forbidden team.
    assert.equal(store.called(), false);
  });

  it('returns an empty list (not an error) for a user in no teams asking for "all"', async () => {
    const store = fakeStore([row()]);
    const app = appWith(store, { userId: 100, teamsMemberOf: [] });

    const res = await get(app, '/api/support/requests');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body['requests'], []);
    // Empty scope short-circuits — the store is never consulted.
    assert.equal(store.called(), false);
  });

  it('serialises a row with the Requests-screen columns (R6.7, R4.5, R4.9)', async () => {
    const store = fakeStore([
      row({ assignedMemberId: 200, assignedMemberName: 'Jane Doe', hasOpenTimer: true }),
    ]);
    const app = appWith(store, { userId: 100, teamsMemberOf: [7, 8] });

    const res = await get(app, '/api/support/requests');

    const [first] = res.body['requests'] as Array<Record<string, unknown>>;
    assert.equal(first['taskReference'], 'REQ-ABC-000001');
    assert.equal(first['jiraNumber'], 'J-1');
    assert.equal(first['title'], 'Broken printer');
    assert.equal(first['dateRaised'], '2026-02-01T09:00:00.000Z');
    assert.equal(first['status'], 'NEW');
    assert.equal(first['teamTitle'], 'Platform');
    assert.equal(first['assignedMemberName'], 'Jane Doe');
    assert.equal(first['lastUpdated'], '2026-02-02T10:30:00.000Z');
    assert.equal(first['hasOpenTimer'], true);
    assert.equal(first['updatedSinceLastSeen'], false);
  });

  it('rejects an invalid scope with 400 VALIDATION_FAILED', async () => {
    const store = fakeStore([]);
    const app = appWith(store, { userId: 100, teamsMemberOf: [7, 8] });

    const res = await get(app, '/api/support/requests?scope=nope');

    assert.equal(res.status, 400);
    assert.equal((res.body['error'] as Record<string, unknown>)['code'], 'VALIDATION_FAILED');
  });
});
