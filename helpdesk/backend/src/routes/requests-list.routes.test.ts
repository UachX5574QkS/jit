import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Express } from 'express';
import { ApiError, errorHandler } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/current-user.js';
import {
  createRequestListRouter,
  parseHideComplete,
  parseScope,
  parseSearch,
} from './requests-list.routes.js';
import type {
  ListViewer,
  RequestListQuery,
  RequestListRow,
  RequestListStore,
} from './requests-list.store.js';

/**
 * Tests for the Requests-list route layer (design: "Requests (user side)" —
 * `GET /api/requests?scope=mine|team&hideComplete=&q=`; R4.1–4.4, R4.9). These
 * exercise query-string parsing, the viewer identity coming from
 * `req.currentUser` (never the query), the response envelope, and the default
 * behaviour (scope=mine, hideComplete=true). The store is a hand-rolled fake so
 * no database is touched — matching the injectable-store route style.
 */

function row(overrides: Partial<RequestListRow> = {}): RequestListRow {
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
  rows: RequestListRow[],
): RequestListStore & { last: () => { query: RequestListQuery; viewer: ListViewer } | null } {
  let last: { query: RequestListQuery; viewer: ListViewer } | null = null;
  return {
    list: async (query, viewer) => {
      last = { query, viewer };
      return rows;
    },
    last: () => last,
  };
}

function stubUser(id: number): CurrentUser {
  return {
    id,
    username: '11111111',
    displayName: 'Test User',
    roles: new Set(['USER']),
    teamsLed: [],
    teamsMemberOf: [],
    isAdmin: false,
    timezone: null,
  };
}

function appWith(store: RequestListStore, userId = 100): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.currentUser = stubUser(userId);
    next();
  });
  app.use('/api', createRequestListRouter(store));
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

describe('parseScope (R4.3)', () => {
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

describe('parseHideComplete (R4.4)', () => {
  it('defaults to true when absent', () => {
    assert.equal(parseHideComplete(undefined), true);
    assert.equal(parseHideComplete(''), true);
  });
  it('parses truthy and falsy spellings', () => {
    assert.equal(parseHideComplete('true'), true);
    assert.equal(parseHideComplete('1'), true);
    assert.equal(parseHideComplete('false'), false);
    assert.equal(parseHideComplete('0'), false);
    assert.equal(parseHideComplete('FALSE'), false);
  });
  it('rejects a non-boolean value', () => {
    assert.throws(
      () => parseHideComplete('maybe'),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });
});

describe('parseSearch (R4.2)', () => {
  it('trims and returns the term, or null when blank/absent', () => {
    assert.equal(parseSearch('  printer '), 'printer');
    assert.equal(parseSearch('   '), null);
    assert.equal(parseSearch(undefined), null);
  });
});

// ── GET /requests (integration through the router) ──────────────────────────────

describe('GET /api/requests (R4.1–4.4, R4.9)', () => {
  it('defaults to scope=mine, hideComplete=true, no search', async () => {
    const store = fakeStore([row()]);
    const app = appWith(store, 100);

    const res = await get(app, '/api/requests');

    assert.equal(res.status, 200);
    assert.deepEqual(store.last()?.query, {
      scope: 'mine',
      hideComplete: true,
      search: null,
    });
    // Viewer identity comes from req.currentUser, not the query string.
    assert.deepEqual(store.last()?.viewer, { userId: 100 });
    assert.equal(res.body['scope'], 'mine');
    assert.equal(res.body['hideComplete'], true);
    assert.equal(res.body['search'], null);
    const requests = res.body['requests'] as unknown[];
    assert.equal(requests.length, 1);
  });

  it('passes scope=team, hideComplete=false and the search term through', async () => {
    const store = fakeStore([]);
    const app = appWith(store, 100);

    const res = await get(app, '/api/requests?scope=team&hideComplete=false&q=toner');

    assert.equal(res.status, 200);
    assert.deepEqual(store.last()?.query, {
      scope: 'team',
      hideComplete: false,
      search: 'toner',
    });
  });

  it('serialises a row with the Requests-screen columns (R4.5, R4.9)', async () => {
    const store = fakeStore([
      row({ assignedMemberId: 200, assignedMemberName: 'Jane Doe', hasOpenTimer: true }),
    ]);
    const app = appWith(store, 100);

    const res = await get(app, '/api/requests');

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
  });

  it('rejects an invalid scope with 400 VALIDATION_FAILED', async () => {
    const store = fakeStore([]);
    const app = appWith(store, 100);

    const res = await get(app, '/api/requests?scope=nope');

    assert.equal(res.status, 400);
    assert.equal((res.body['error'] as Record<string, unknown>)['code'], 'VALIDATION_FAILED');
  });
});
