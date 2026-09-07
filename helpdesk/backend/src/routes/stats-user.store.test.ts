import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Queryable } from '../db/query.js';
import {
  DbUserStatsStore,
  averageOrNull,
  isTriageCompleteExcluded,
  zeroCountByStatus,
  TRIAGE_COMPLETE_EXCLUDED,
} from './stats-user.store.js';

/**
 * Tests for the Postgres-backed User-Statistics store (design: "Statistics" —
 * `GET /api/stats/user`; R10, R18.3). A fake {@link Queryable} answers each of
 * the store's SELECTs from a response keyed on a distinctive fragment of the
 * SQL (the store issues them concurrently via Promise.all, so responses are
 * matched by content, not call order) and records every call (SQL + bound
 * params). This exercises WITHOUT a live database:
 *   • the timezone month-bucketing SQL binds the tz as a parameter and rebases
 *     created_at with `AT TIME ZONE $2` (R10.1, R18.3) — never interpolated;
 *   • the duration SQL applies the Rejected/Cancelled exclusion to the
 *     Triage→Complete average but NOT to New→Triage (R10.4, R10.5), with the
 *     TRIAGE/COMPLETE/excluded statuses all bound (R22.2);
 *   • the summary merge combines per-status counts with per-type durations,
 *     computes requestCount, and zero-fills absent statuses.
 * The pure helpers are also unit-tested directly.
 */

interface RecordedCall {
  readonly text: string;
  readonly params: readonly unknown[];
}

/**
 * A fake queryable whose response for each call is chosen by the first matching
 * predicate in `routes` (matched against the SQL text). Records every call so
 * the parameterisation and SQL-shape invariants can be asserted.
 */
function fakeDb(
  routes: ReadonlyArray<{ match: RegExp; rows: unknown[] }>,
): { db: Queryable; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const db = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params: params ?? [] });
      const route = routes.find((r) => r.match.test(text));
      const rows = route ? route.rows : [];
      return { rows, rowCount: rows.length } as never;
    },
  } as unknown as Queryable;
  return { db, calls };
}

/** Locate a recorded call by a distinctive SQL fragment. */
function call(calls: RecordedCall[], match: RegExp): RecordedCall {
  const found = calls.find((c) => match.test(c.text));
  assert.ok(found, `expected a query matching ${match}`);
  return found;
}

/** The four SQL fragments that uniquely identify the store's queries. */
const STATUS_BY_MONTH = /date_trunc\('month'/;
const TIME_BY_TYPE = /SUM\(ts\.duration_minutes\)/;
const STATUS_COUNTS = /GROUP BY t\.id, t\.name, r\.status/;
const DURATIONS = /avg_new_to_triage_seconds/;
// The type-count pie is the only query ordered by `count DESC`.
const TYPE_COUNTS = /ORDER BY count DESC, t\.name/;

/** A full route table returning empty rows for every query (override per test). */
function emptyRoutes(): Array<{ match: RegExp; rows: unknown[] }> {
  return [
    { match: STATUS_BY_MONTH, rows: [] },
    { match: STATUS_COUNTS, rows: [] },
    { match: DURATIONS, rows: [] },
    { match: TIME_BY_TYPE, rows: [] },
    { match: TYPE_COUNTS, rows: [] },
  ];
}

// ── Pure helpers ────────────────────────────────────────────────────────────────

describe('averageOrNull', () => {
  it('averages a non-empty list', () => {
    assert.equal(averageOrNull([10, 20, 30]), 20);
    assert.equal(averageOrNull([5]), 5);
  });
  it('returns null for an empty list (no divide by zero)', () => {
    assert.equal(averageOrNull([]), null);
  });
});

describe('isTriageCompleteExcluded (R10.5)', () => {
  it('excludes REJECTED and CANCELLED', () => {
    assert.equal(isTriageCompleteExcluded('REJECTED'), true);
    assert.equal(isTriageCompleteExcluded('CANCELLED'), true);
  });
  it('does not exclude COMPLETE or any active status', () => {
    assert.equal(isTriageCompleteExcluded('COMPLETE'), false);
    assert.equal(isTriageCompleteExcluded('ACTIVE'), false);
    assert.equal(isTriageCompleteExcluded('NEW'), false);
  });
});

describe('zeroCountByStatus', () => {
  it('has every lifecycle status present at zero', () => {
    const z = zeroCountByStatus();
    assert.equal(z.NEW, 0);
    assert.equal(z.TRIAGE, 0);
    assert.equal(z.COMPLETE, 0);
    assert.equal(z.REJECTED, 0);
    assert.equal(z.CANCELLED, 0);
  });
});

// ── Status-by-month: timezone bucketing (R10.1, R18.3) ──────────────────────────

describe('DbUserStatsStore — status-by-month timezone bucketing (R10.1, R18.3)', () => {
  it('binds the viewer id and IANA timezone as parameters and rebases with AT TIME ZONE $2', async () => {
    const routes = emptyRoutes();
    routes[0] = {
      match: STATUS_BY_MONTH,
      rows: [
        { month: '2026-01', status: 'NEW', count: 2 },
        { month: '2026-02', status: 'COMPLETE', count: 1 },
      ],
    };
    const { db, calls } = fakeDb(routes);
    const store = new DbUserStatsStore(db);

    const view = await store.getUserStats({ userId: 42, timezone: 'Europe/London' });

    const c = call(calls, STATUS_BY_MONTH);
    // Viewer id ($1) and timezone ($2) are the only bound values; neither the
    // id nor the timezone is interpolated into the SQL text (R22.2).
    assert.deepEqual(c.params, [42, 'Europe/London']);
    assert.ok(
      !c.text.includes('Europe/London'),
      'timezone must be bound, not interpolated',
    );
    assert.match(c.text, /AT TIME ZONE \$2/);
    assert.match(c.text, /r\.raised_by_id = \$1/);

    // Rows map straight through to (month, status, count) buckets.
    assert.deepEqual(view.statusByMonth, [
      { month: '2026-01', status: 'NEW', count: 2 },
      { month: '2026-02', status: 'COMPLETE', count: 1 },
    ]);
  });

  it('rebasing changes the bucket a month-boundary timestamp lands in (documented via the query shape)', async () => {
    // The store cannot re-bucket in a unit test — the rebasing lives in the SQL
    // (`date_trunc('month', created_at AT TIME ZONE $2)`). Prove the two viewers
    // get IDENTICAL SQL but DIFFERENT bound timezones, which is exactly what
    // makes a 23:30 UTC end-of-month request bucket differently per zone (R18.3).
    const utc = fakeDb(emptyRoutes());
    const tokyo = fakeDb(emptyRoutes());

    await new DbUserStatsStore(utc.db).getUserStats({ userId: 1, timezone: 'UTC' });
    await new DbUserStatsStore(tokyo.db).getUserStats({
      userId: 1,
      timezone: 'Asia/Tokyo',
    });

    const utcCall = call(utc.calls, STATUS_BY_MONTH);
    const tokyoCall = call(tokyo.calls, STATUS_BY_MONTH);
    assert.equal(utcCall.text, tokyoCall.text, 'same SQL, only the bound tz differs');
    assert.deepEqual(utcCall.params, [1, 'UTC']);
    assert.deepEqual(tokyoCall.params, [1, 'Asia/Tokyo']);
  });
});

// ── Type pies (R10.2, R10.3) ────────────────────────────────────────────────────

describe('DbUserStatsStore — type pies (R10.2, R10.3)', () => {
  it('maps the type-count pie and scopes to the viewer', async () => {
    const routes = emptyRoutes();
    routes[4] = {
      match: TYPE_COUNTS,
      rows: [
        { task_id: 5, task_name: 'Access', count: '3' },
        { task_id: 6, task_name: 'Hardware', count: 1 },
      ],
    };
    const { db, calls } = fakeDb(routes);
    const store = new DbUserStatsStore(db);

    const view = await store.getUserStats({ userId: 9, timezone: 'UTC' });

    assert.deepEqual(view.typeCounts, [
      { taskId: 5, taskName: 'Access', count: 3 },
      { taskId: 6, taskName: 'Hardware', count: 1 },
    ]);
    assert.deepEqual(call(calls, TYPE_COUNTS).params, [9]);
  });

  it('maps the time-by-type pie (COALESCEd minutes, viewer-scoped)', async () => {
    const routes = emptyRoutes();
    routes[3] = {
      match: TIME_BY_TYPE,
      rows: [
        { task_id: 5, task_name: 'Access', total_minutes: '120' },
        { task_id: 6, task_name: 'Hardware', total_minutes: 0 },
      ],
    };
    const { db, calls } = fakeDb(routes);
    const store = new DbUserStatsStore(db);

    const view = await store.getUserStats({ userId: 9, timezone: 'UTC' });

    assert.deepEqual(view.timeByType, [
      { taskId: 5, taskName: 'Access', totalMinutes: 120 },
      { taskId: 6, taskName: 'Hardware', totalMinutes: 0 },
    ]);
    const c = call(calls, TIME_BY_TYPE);
    assert.deepEqual(c.params, [9]);
    // A LEFT JOIN keeps a type with no recorded slices in the result at 0.
    assert.match(c.text, /LEFT JOIN time_slice ts/);
  });
});

// ── Summary table + Rejected/Cancelled exclusion (R10.4, R10.5) ─────────────────

describe('DbUserStatsStore — summary durations exclusion (R10.4, R10.5)', () => {
  it('binds TRIAGE/COMPLETE/excluded statuses and applies the exclusion only to Triage→Complete', async () => {
    const routes = emptyRoutes();
    routes[2] = {
      match: DURATIONS,
      rows: [
        {
          task_id: 5,
          task_name: 'Access',
          avg_new_to_triage_seconds: '600',
          avg_triage_to_complete_seconds: '7200',
        },
      ],
    };
    const { db, calls } = fakeDb(routes);
    const store = new DbUserStatsStore(db);

    await store.getUserStats({ userId: 9, timezone: 'UTC' });

    const c = call(calls, DURATIONS);
    // Params: viewer id, TRIAGE, COMPLETE, [REJECTED, CANCELLED] — all bound.
    assert.deepEqual(c.params, [9, 'TRIAGE', 'COMPLETE', ['REJECTED', 'CANCELLED']]);
    assert.deepEqual([...TRIAGE_COMPLETE_EXCLUDED], ['REJECTED', 'CANCELLED']);
    // Neither status literal is interpolated into the SQL text (R22.2).
    assert.ok(!c.text.includes("'TRIAGE'"), 'TRIAGE must be bound, not interpolated');
    assert.ok(!c.text.includes("'COMPLETE'"), 'COMPLETE must be bound, not interpolated');
    assert.ok(
      !c.text.includes("'REJECTED'") && !c.text.includes("'CANCELLED'"),
      'excluded statuses must be bound, not interpolated',
    );
    // The exclusion FILTER applies to Triage→Complete only.
    assert.match(c.text, /FILTER \(\s*WHERE m\.triage_at IS NOT NULL\)/);
    assert.match(c.text, /m\.status <> ALL\(\$4::text\[\]\)/);
    // The transition moments come from status audit entries.
    assert.match(c.text, /ae\.field_name = 'status'/);
    assert.match(c.text, /ae\.new_value = \$2/);
    assert.match(c.text, /ae\.new_value = \$3/);
  });

  it('merges per-status counts with per-type durations, computes requestCount, and zero-fills statuses', async () => {
    const routes = emptyRoutes();
    routes[1] = {
      match: STATUS_COUNTS,
      rows: [
        { task_id: 5, task_name: 'Access', status: 'NEW', count: '1' },
        { task_id: 5, task_name: 'Access', status: 'COMPLETE', count: '2' },
      ],
    };
    routes[2] = {
      match: DURATIONS,
      rows: [
        {
          task_id: 5,
          task_name: 'Access',
          avg_new_to_triage_seconds: 300,
          avg_triage_to_complete_seconds: 3600,
        },
      ],
    };
    const { db } = fakeDb(routes);
    const store = new DbUserStatsStore(db);

    const view = await store.getUserStats({ userId: 9, timezone: 'UTC' });

    assert.equal(view.summary.length, 1);
    const row = view.summary[0]!;
    assert.equal(row.taskId, 5);
    assert.equal(row.taskName, 'Access');
    // requestCount is the sum across statuses (1 + 2).
    assert.equal(row.requestCount, 3);
    // Present statuses carry their counts; absent statuses are zero-filled.
    assert.equal(row.countByStatus.NEW, 1);
    assert.equal(row.countByStatus.COMPLETE, 2);
    assert.equal(row.countByStatus.TRIAGE, 0);
    assert.equal(row.countByStatus.REJECTED, 0);
    assert.equal(row.avgNewToTriageSeconds, 300);
    assert.equal(row.avgTriageToCompleteSeconds, 3600);
  });

  it('carries a null Triage→Complete average through when no request qualifies', async () => {
    // The DB returns NULL for the FILTERed AVG when every complete-ish request
    // was Rejected/Cancelled (excluded) or none reached both moments (R10.5).
    const routes = emptyRoutes();
    routes[1] = {
      match: STATUS_COUNTS,
      rows: [{ task_id: 5, task_name: 'Access', status: 'CANCELLED', count: 2 }],
    };
    routes[2] = {
      match: DURATIONS,
      rows: [
        {
          task_id: 5,
          task_name: 'Access',
          avg_new_to_triage_seconds: 120,
          avg_triage_to_complete_seconds: null,
        },
      ],
    };
    const { db } = fakeDb(routes);
    const store = new DbUserStatsStore(db);

    const view = await store.getUserStats({ userId: 9, timezone: 'UTC' });

    const row = view.summary[0]!;
    assert.equal(row.requestCount, 2);
    assert.equal(row.countByStatus.CANCELLED, 2);
    // New→Triage still computed; Triage→Complete is null (all excluded).
    assert.equal(row.avgNewToTriageSeconds, 120);
    assert.equal(row.avgTriageToCompleteSeconds, null);
  });

  it('orders summary rows by requestCount desc then name', async () => {
    const routes = emptyRoutes();
    routes[1] = {
      match: STATUS_COUNTS,
      rows: [
        { task_id: 5, task_name: 'Access', status: 'NEW', count: 1 },
        { task_id: 6, task_name: 'Hardware', status: 'NEW', count: 4 },
        { task_id: 7, task_name: 'Billing', status: 'NEW', count: 1 },
      ],
    };
    const { db } = fakeDb(routes);
    const store = new DbUserStatsStore(db);

    const view = await store.getUserStats({ userId: 9, timezone: 'UTC' });

    assert.deepEqual(
      view.summary.map((r) => r.taskName),
      ['Hardware', 'Access', 'Billing'],
    );
  });
});
