import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Express } from 'express';
import { errorHandler } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/current-user.js';
import { createTeamStatsRouter } from './stats-team.routes.js';
import type {
  TeamStatsQuery,
  TeamStatsStore,
  TeamStatsView,
} from './stats-team.store.js';
import { zeroCountByStatus } from './stats-team.store.js';

/**
 * Tests for the Team-Statistics route layer (design: "Statistics" —
 * `GET /api/stats/team`; R11, R19, R18.3). These exercise the viewer identity
 * coming from `req.currentUser` (never the query), timezone resolution shared
 * with the user-stats route (the `?tz=` override, the CurrentUser fallback, the
 * UTC default, and rejection of an invalid explicit tz), and the response
 * envelope. The store is a hand-rolled fake so no database is touched —
 * matching the injectable-store route style.
 */

function emptyView(): TeamStatsView {
  return { statusByMonth: [], typeCounts: [], timeByType: [], summary: [] };
}

/** A fake store that records the query it was called with and returns `view`. */
function fakeStore(
  view: TeamStatsView,
): TeamStatsStore & { last: () => TeamStatsQuery | null } {
  let last: TeamStatsQuery | null = null;
  return {
    getTeamStats: async (query) => {
      last = query;
      return view;
    },
    last: () => last,
  };
}

function stubUser(id: number, timezone: string | null = null): CurrentUser {
  return {
    id,
    username: '11111111',
    displayName: 'Test Manager',
    roles: new Set(['USER']),
    teamsLed: [],
    teamsMemberOf: [],
    isAdmin: false,
    timezone,
  };
}

function appWith(store: TeamStatsStore, user: CurrentUser): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.currentUser = user;
    next();
  });
  app.use('/api/stats', createTeamStatsRouter(store));
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

// ── Endpoint behaviour ──────────────────────────────────────────────────────────

describe('GET /api/stats/team (R11, R19, R18.3)', () => {
  it('passes the current user id (hierarchy root) and resolved timezone to the store', async () => {
    const store = fakeStore(emptyView());
    const app = appWith(store, stubUser(42, null));

    const res = await get(app, '/api/stats/team?tz=Europe/London');

    assert.equal(res.status, 200);
    assert.deepEqual(store.last(), { userId: 42, timezone: 'Europe/London' });
    // The resolved timezone is echoed in the response.
    assert.equal(res.body['timezone'], 'Europe/London');
  });

  it('derives the hierarchy root from req.currentUser, never the query string', async () => {
    const store = fakeStore(emptyView());
    // A malicious ?userId is ignored — the store sees the authenticated id.
    const app = appWith(store, stubUser(7, 'UTC'));

    await get(app, '/api/stats/team?userId=999');

    assert.equal(store.last()?.userId, 7);
  });

  it('uses the user timezone when ?tz is omitted', async () => {
    const store = fakeStore(emptyView());
    const app = appWith(store, stubUser(3, 'Asia/Tokyo'));

    const res = await get(app, '/api/stats/team');

    assert.equal(store.last()?.timezone, 'Asia/Tokyo');
    assert.equal(res.body['timezone'], 'Asia/Tokyo');
  });

  it('falls back to UTC when neither ?tz nor a user timezone is present', async () => {
    const store = fakeStore(emptyView());
    const app = appWith(store, stubUser(3, null));

    const res = await get(app, '/api/stats/team');

    assert.equal(store.last()?.timezone, 'UTC');
    assert.equal(res.body['timezone'], 'UTC');
  });

  it('rejects an invalid ?tz with 400 VALIDATION_FAILED', async () => {
    const store = fakeStore(emptyView());
    const app = appWith(store, stubUser(3, 'UTC'));

    const res = await get(app, '/api/stats/team?tz=Bad/Zone');

    assert.equal(res.status, 400);
    const err = res.body['error'] as { code?: string };
    assert.equal(err.code, 'VALIDATION_FAILED');
  });

  it('serialises the four datasets into the response envelope', async () => {
    const countByStatus = zeroCountByStatus();
    countByStatus.NEW = 1;
    countByStatus.COMPLETE = 2;
    const view: TeamStatsView = {
      statusByMonth: [{ month: '2026-02', status: 'NEW', count: 1 }],
      typeCounts: [{ taskId: 5, taskName: 'Access', count: 3 }],
      timeByType: [{ taskId: 5, taskName: 'Access', totalMinutes: 120 }],
      summary: [
        {
          taskId: 5,
          taskName: 'Access',
          requestCount: 3,
          countByStatus,
          avgNewToTriageSeconds: 600,
          avgTriageToCompleteSeconds: 7200,
        },
      ],
    };
    const app = appWith(fakeStore(view), stubUser(1, 'UTC'));

    const res = await get(app, '/api/stats/team');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body['statusByMonth'], [
      { month: '2026-02', status: 'NEW', count: 1 },
    ]);
    assert.deepEqual(res.body['typeCounts'], [
      { taskId: 5, taskName: 'Access', count: 3 },
    ]);
    assert.deepEqual(res.body['timeByType'], [
      { taskId: 5, taskName: 'Access', totalMinutes: 120 },
    ]);
    const summary = res.body['summary'] as Array<Record<string, unknown>>;
    assert.equal(summary.length, 1);
    assert.equal(summary[0]!['avgNewToTriageSeconds'], 600);
    assert.equal(summary[0]!['avgTriageToCompleteSeconds'], 7200);
    assert.equal(summary[0]!['requestCount'], 3);
  });

  it('returns empty datasets for a manager with no reports', async () => {
    const store = fakeStore(emptyView());
    const app = appWith(store, stubUser(1, 'UTC'));

    const res = await get(app, '/api/stats/team');

    assert.equal(res.status, 200);
    assert.deepEqual(res.body['statusByMonth'], []);
    assert.deepEqual(res.body['summary'], []);
  });
});
