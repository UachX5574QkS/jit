import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Express } from 'express';
import { ApiError, errorHandler } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/current-user.js';
import {
  createUserStatsRouter,
  isValidTimezone,
  resolveTimezone,
} from './stats-user.routes.js';
import type {
  UserStatsQuery,
  UserStatsStore,
  UserStatsView,
} from './stats-user.store.js';
import { zeroCountByStatus } from './stats-user.store.js';

/**
 * Tests for the User-Statistics route layer (design: "Statistics" —
 * `GET /api/stats/user`; R10, R18.3). These exercise timezone resolution (the
 * `?tz=` override, the CurrentUser fallback, the UTC default, and rejection of
 * an invalid explicit tz), the viewer identity coming from `req.currentUser`
 * (never the query), and the response envelope. The store is a hand-rolled fake
 * so no database is touched — matching the injectable-store route style.
 */

function emptyView(): UserStatsView {
  return { statusByMonth: [], typeCounts: [], timeByType: [], summary: [] };
}

/** A fake store that records the query it was called with and returns `view`. */
function fakeStore(
  view: UserStatsView,
): UserStatsStore & { last: () => UserStatsQuery | null } {
  let last: UserStatsQuery | null = null;
  return {
    getUserStats: async (query) => {
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
    displayName: 'Test User',
    roles: new Set(['USER']),
    teamsLed: [],
    teamsMemberOf: [],
    isAdmin: false,
    timezone,
  };
}

function appWith(store: UserStatsStore, user: CurrentUser): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.currentUser = user;
    next();
  });
  app.use('/api/stats', createUserStatsRouter(store));
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

// ── Timezone validation / resolution (unit; R10.1, R18.3) ───────────────────────

describe('isValidTimezone', () => {
  it('accepts recognised IANA names and UTC', () => {
    assert.equal(isValidTimezone('UTC'), true);
    assert.equal(isValidTimezone('Europe/London'), true);
    assert.equal(isValidTimezone('America/New_York'), true);
  });
  it('rejects blank and malformed names', () => {
    assert.equal(isValidTimezone(''), false);
    assert.equal(isValidTimezone('   '), false);
    assert.equal(isValidTimezone('Not/AZone'), false);
    assert.equal(isValidTimezone('Europe/Nowhere'), false);
  });
});

describe('resolveTimezone (R10.1, R18.3)', () => {
  it('prefers an explicit valid ?tz over the user timezone', () => {
    const user = stubUser(1, 'America/New_York');
    assert.equal(resolveTimezone('Europe/London', user), 'Europe/London');
  });
  it('falls back to the user timezone when ?tz is absent', () => {
    const user = stubUser(1, 'America/New_York');
    assert.equal(resolveTimezone(undefined, user), 'America/New_York');
    assert.equal(resolveTimezone('', user), 'America/New_York');
  });
  it('falls back to UTC when neither ?tz nor a user timezone is present', () => {
    assert.equal(resolveTimezone(undefined, stubUser(1, null)), 'UTC');
  });
  it('ignores an invalid stored user timezone and uses UTC', () => {
    assert.equal(resolveTimezone(undefined, stubUser(1, 'Bad/Zone')), 'UTC');
  });
  it('rejects an explicit invalid ?tz with VALIDATION_FAILED (no silent fallback)', () => {
    assert.throws(
      () => resolveTimezone('Bad/Zone', stubUser(1, 'UTC')),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });
});

// ── Endpoint behaviour ──────────────────────────────────────────────────────────

describe('GET /api/stats/user (R10, R18.3)', () => {
  it('passes the current user id and resolved timezone to the store', async () => {
    const store = fakeStore(emptyView());
    const app = appWith(store, stubUser(42, null));

    const res = await get(app, '/api/stats/user?tz=Europe/London');

    assert.equal(res.status, 200);
    assert.deepEqual(store.last(), { userId: 42, timezone: 'Europe/London' });
    // The resolved timezone is echoed in the response.
    assert.equal(res.body['timezone'], 'Europe/London');
  });

  it('derives the viewer from req.currentUser, never the query string', async () => {
    const store = fakeStore(emptyView());
    // A malicious ?userId is ignored — the store sees the authenticated id.
    const app = appWith(store, stubUser(7, 'UTC'));

    await get(app, '/api/stats/user?userId=999');

    assert.equal(store.last()?.userId, 7);
  });

  it('uses the user timezone when ?tz is omitted', async () => {
    const store = fakeStore(emptyView());
    const app = appWith(store, stubUser(3, 'Asia/Tokyo'));

    const res = await get(app, '/api/stats/user');

    assert.equal(store.last()?.timezone, 'Asia/Tokyo');
    assert.equal(res.body['timezone'], 'Asia/Tokyo');
  });

  it('rejects an invalid ?tz with 400 VALIDATION_FAILED', async () => {
    const store = fakeStore(emptyView());
    const app = appWith(store, stubUser(3, 'UTC'));

    const res = await get(app, '/api/stats/user?tz=Bad/Zone');

    assert.equal(res.status, 400);
    const err = res.body['error'] as { code?: string };
    assert.equal(err.code, 'VALIDATION_FAILED');
  });

  it('serialises the four datasets into the response envelope', async () => {
    const countByStatus = zeroCountByStatus();
    countByStatus.NEW = 1;
    countByStatus.COMPLETE = 2;
    const view: UserStatsView = {
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

    const res = await get(app, '/api/stats/user');

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
});
