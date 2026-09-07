import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Express } from 'express';
import { errorHandler } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/current-user.js';
import {
  createSupportStatsRouter,
  densifyAssignedCounts,
  densifyAvgDurations,
} from './stats-support.routes.js';
import type {
  SupportStatsQuery,
  SupportStatsStore,
  SupportStatsView,
} from './stats-support.store.js';

/**
 * Tests for the Support-Statistics route layer (design: "Statistics" —
 * `GET /api/stats/support`; R12). These exercise the team selector + "All
 * Teams" scoping resolved against the caller's team memberships (R12.1), the
 * shared timezone resolution, the membership-check FORBIDDEN boundary, the
 * "Team - Task" row-label rule, and the dense (rows × members) grid
 * serialisation (R12.3/R12.4). The store is a hand-rolled fake so no database
 * is touched.
 */

function emptyView(): SupportStatsView {
  return {
    statusByMonth: [],
    members: [],
    rows: [],
    assignedCounts: [],
    avgAcceptedToComplete: [],
  };
}

function fakeStore(
  view: SupportStatsView,
): SupportStatsStore & { last: () => SupportStatsQuery | null } {
  let last: SupportStatsQuery | null = null;
  return {
    getSupportStats: async (query) => {
      last = query;
      return view;
    },
    last: () => last,
  };
}

function stubUser(
  id: number,
  teamsMemberOf: number[],
  timezone: string | null = null,
): CurrentUser {
  return {
    id,
    username: '11111111',
    displayName: 'Support Person',
    roles: new Set(teamsMemberOf.length ? ['USER', 'SUPPORT_MEMBER'] : ['USER']),
    teamsLed: [],
    teamsMemberOf,
    isAdmin: false,
    timezone,
  };
}

function appWith(store: SupportStatsStore, user: CurrentUser): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.currentUser = user;
    next();
  });
  app.use('/api/stats', createSupportStatsRouter(store));
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

// ── Pure grid densification helpers (R12.3/R12.4) ───────────────────────────────

describe('densifyAssignedCounts (R12.3)', () => {
  it('zero-fills the full (rows × members) cross-product', () => {
    const rows = [
      { taskId: 5, taskName: 'Access', teamId: 7, teamTitle: 'Platform' },
      { taskId: 6, taskName: 'Hardware', teamId: 7, teamTitle: 'Platform' },
    ];
    const members = [
      { memberId: 10, memberName: 'Alice' },
      { memberId: 11, memberName: 'Bob' },
    ];
    const cells = [{ taskId: 5, memberId: 10, count: 3 }];

    const dense = densifyAssignedCounts(rows, members, cells);

    assert.equal(dense.length, 4, 'a cell for every (task, member) pair');
    assert.deepEqual(dense, [
      { taskId: 5, memberId: 10, count: 3 },
      { taskId: 5, memberId: 11, count: 0 },
      { taskId: 6, memberId: 10, count: 0 },
      { taskId: 6, memberId: 11, count: 0 },
    ]);
  });
});

describe('densifyAvgDurations (R12.4)', () => {
  it('null-fills the full (rows × members) cross-product', () => {
    const rows = [{ taskId: 5, taskName: 'Access', teamId: 7, teamTitle: 'Platform' }];
    const members = [
      { memberId: 10, memberName: 'Alice' },
      { memberId: 11, memberName: 'Bob' },
    ];
    const cells = [{ taskId: 5, memberId: 10, avgAcceptedToCompleteSeconds: 7200 }];

    const dense = densifyAvgDurations(rows, members, cells);

    assert.deepEqual(dense, [
      { taskId: 5, memberId: 10, avgAcceptedToCompleteSeconds: 7200 },
      { taskId: 5, memberId: 11, avgAcceptedToCompleteSeconds: null },
    ]);
  });
});

// ── Team selector + All-Teams scoping (R12.1) ───────────────────────────────────

describe('GET /api/stats/support — team scoping (R12.1)', () => {
  it('"all" (default) scopes to every team the caller is a member of', async () => {
    const store = fakeStore(emptyView());
    const app = appWith(store, stubUser(1, [7, 9], 'UTC'));

    const res = await get(app, '/api/stats/support');

    assert.equal(res.status, 200);
    assert.deepEqual([...(store.last()!.teamIds as number[])].sort((a, b) => a - b), [7, 9]);
    assert.equal(res.body['team'], 'all');
  });

  it('a specific team the caller is a member of scopes to that one team', async () => {
    const store = fakeStore(emptyView());
    const app = appWith(store, stubUser(1, [7, 9], 'UTC'));

    const res = await get(app, '/api/stats/support?team=9');

    assert.equal(res.status, 200);
    assert.deepEqual([...(store.last()!.teamIds as number[])], [9]);
    assert.equal(res.body['team'], 9);
  });

  it('a specific team the caller is NOT a member of is FORBIDDEN', async () => {
    const store = fakeStore(emptyView());
    const app = appWith(store, stubUser(1, [7], 'UTC'));

    const res = await get(app, '/api/stats/support?team=99');

    assert.equal(res.status, 403);
    const err = res.body['error'] as { code?: string };
    assert.equal(err.code, 'FORBIDDEN');
  });

  it('an invalid team value is VALIDATION_FAILED', async () => {
    const store = fakeStore(emptyView());
    const app = appWith(store, stubUser(1, [7], 'UTC'));

    const res = await get(app, '/api/stats/support?team=abc');

    assert.equal(res.status, 400);
    const err = res.body['error'] as { code?: string };
    assert.equal(err.code, 'VALIDATION_FAILED');
  });

  it('a caller in no teams resolves to an empty scope under "all"', async () => {
    const store = fakeStore(emptyView());
    const app = appWith(store, stubUser(1, [], 'UTC'));

    const res = await get(app, '/api/stats/support');

    assert.equal(res.status, 200);
    assert.deepEqual([...(store.last()!.teamIds as number[])], []);
  });
});

// ── Timezone resolution (R12.2 → R18.3) ─────────────────────────────────────────

describe('GET /api/stats/support — timezone (R12.2 → R18.3)', () => {
  it('an explicit ?tz wins and is echoed back', async () => {
    const store = fakeStore(emptyView());
    const app = appWith(store, stubUser(1, [7], null));

    const res = await get(app, '/api/stats/support?tz=Europe/London');

    assert.equal(store.last()?.timezone, 'Europe/London');
    assert.equal(res.body['timezone'], 'Europe/London');
  });

  it('falls back to the user timezone, then UTC', async () => {
    const withTz = fakeStore(emptyView());
    const withoutTz = fakeStore(emptyView());

    const resA = await get(appWith(withTz, stubUser(1, [7], 'Asia/Tokyo')), '/api/stats/support');
    const resB = await get(appWith(withoutTz, stubUser(1, [7], null)), '/api/stats/support');

    assert.equal(withTz.last()?.timezone, 'Asia/Tokyo');
    assert.equal(resA.body['timezone'], 'Asia/Tokyo');
    assert.equal(withoutTz.last()?.timezone, 'UTC');
    assert.equal(resB.body['timezone'], 'UTC');
  });

  it('rejects an invalid explicit ?tz with 400 VALIDATION_FAILED', async () => {
    const store = fakeStore(emptyView());
    const app = appWith(store, stubUser(1, [7], 'UTC'));

    const res = await get(app, '/api/stats/support?tz=Bad/Zone');

    assert.equal(res.status, 400);
    const err = res.body['error'] as { code?: string };
    assert.equal(err.code, 'VALIDATION_FAILED');
  });
});

// ── Row labels: Task vs "Team - Task" (R12.3) ───────────────────────────────────

describe('GET /api/stats/support — row labels (R12.3)', () => {
  it('uses the bare task name when a single team is in scope', async () => {
    const view: SupportStatsView = {
      ...emptyView(),
      rows: [{ taskId: 5, taskName: 'Access', teamId: 7, teamTitle: 'Platform' }],
    };
    const app = appWith(fakeStore(view), stubUser(1, [7], 'UTC'));

    const res = await get(app, '/api/stats/support?team=7');

    const rows = res.body['rows'] as Array<Record<string, unknown>>;
    assert.equal(rows[0]!['label'], 'Access');
  });

  it('prefixes with the team ("Team - Task") when more than one team is in scope', async () => {
    const view: SupportStatsView = {
      ...emptyView(),
      rows: [
        { taskId: 5, taskName: 'Access', teamId: 7, teamTitle: 'Platform' },
        { taskId: 8, taskName: 'Onboarding', teamId: 9, teamTitle: 'People' },
      ],
    };
    const app = appWith(fakeStore(view), stubUser(1, [7, 9], 'UTC'));

    const res = await get(app, '/api/stats/support');

    const rows = res.body['rows'] as Array<Record<string, unknown>>;
    assert.equal(rows[0]!['label'], 'Platform - Access');
    assert.equal(rows[1]!['label'], 'People - Onboarding');
  });
});

// ── Response envelope + dense grids (R12.2/R12.3/R12.4) ──────────────────────────

describe('GET /api/stats/support — response envelope', () => {
  it('serialises the chart and both dense tables', async () => {
    const view: SupportStatsView = {
      statusByMonth: [{ month: '2026-02', status: 'NEW', count: 1 }],
      members: [
        { memberId: 10, memberName: 'Alice' },
        { memberId: 11, memberName: 'Bob' },
      ],
      rows: [{ taskId: 5, taskName: 'Access', teamId: 7, teamTitle: 'Platform' }],
      assignedCounts: [{ taskId: 5, memberId: 10, count: 3 }],
      avgAcceptedToComplete: [{ taskId: 5, memberId: 10, avgAcceptedToCompleteSeconds: 7200 }],
    };
    const app = appWith(fakeStore(view), stubUser(1, [7], 'UTC'));

    const res = await get(app, '/api/stats/support?team=7');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body['statusByMonth'], [
      { month: '2026-02', status: 'NEW', count: 1 },
    ]);
    // The assigned-count grid is dense: a cell for every (task, member) pair.
    assert.deepEqual(res.body['assignedCounts'], [
      { taskId: 5, memberId: 10, count: 3 },
      { taskId: 5, memberId: 11, count: 0 },
    ]);
    // The duration grid is dense with nulls where there is no qualifying request.
    assert.deepEqual(res.body['avgAcceptedToComplete'], [
      { taskId: 5, memberId: 10, avgAcceptedToCompleteSeconds: 7200 },
      { taskId: 5, memberId: 11, avgAcceptedToCompleteSeconds: null },
    ]);
  });

  it('derives the caller from req.currentUser, not the query string', async () => {
    const store = fakeStore(emptyView());
    const app = appWith(store, stubUser(42, [7], 'UTC'));

    await get(app, '/api/stats/support?userId=999');

    // The scope is the caller's team memberships, not any query param.
    assert.deepEqual([...(store.last()!.teamIds as number[])], [7]);
  });
});
