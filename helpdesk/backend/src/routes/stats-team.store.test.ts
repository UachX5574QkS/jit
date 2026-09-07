import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Queryable } from '../db/query.js';
import type {
  ManagerGraph,
  ManagerGraphLoader,
  UserId,
} from '../hierarchy/index.js';
import {
  DbTeamStatsStore,
  averageOrNull,
  isTriageCompleteExcluded,
  zeroCountByStatus,
  TRIAGE_COMPLETE_EXCLUDED,
} from './stats-team.store.js';

/**
 * Tests for the Postgres-backed Team-Statistics store (design: "Statistics" —
 * `GET /api/stats/team`; R11, R19). A fake {@link Queryable} answers each SELECT
 * from a response keyed on a distinctive fragment of the SQL (the store issues
 * them concurrently via Promise.all, so responses are matched by content, not
 * call order) and records every call (SQL + bound params). A fake
 * {@link ManagerGraphLoader} supplies an in-memory manager graph so the
 * hierarchy scoping is exercised WITHOUT a live database. Together they pin down:
 *   • the hierarchy is resolved from the current user and bound as ONE array
 *     parameter matched with `= ANY($1)` — the area-manager cutoff and cycle
 *     guard of R19 are reused, not reimplemented (R11.1, R19);
 *   • an empty hierarchy short-circuits to empty datasets and issues NO SQL;
 *   • the timezone month-bucketing SQL binds the tz as $2 and rebases with
 *     `AT TIME ZONE $2` (R11.2 → R10.1, R18.3) — never interpolated;
 *   • the duration SQL applies the Rejected/Cancelled exclusion to the
 *     Triage→Complete average but NOT to New→Triage (R11.2 → R10.4, R10.5),
 *     with the TRIAGE/COMPLETE/excluded statuses all bound (R22.2);
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

/**
 * Build a {@link ManagerGraph} from a `{report: manager}` map, plus an optional
 * list of area-manager ids. Mirrors the helper the hierarchy unit tests use.
 */
function graphOf(
  edges: Record<number, number>,
  areaManagers: number[] = [],
): ManagerGraph {
  const directReports = new Map<UserId, Set<UserId>>();
  for (const [reportStr, managerId] of Object.entries(edges)) {
    const reportId = Number(reportStr);
    let reports = directReports.get(managerId);
    if (!reports) {
      reports = new Set<UserId>();
      directReports.set(managerId, reports);
    }
    reports.add(reportId);
  }
  return { directReports, areaManagerIds: new Set<UserId>(areaManagers) };
}

/** A fake loader returning `graph`, recording how many times it was consulted. */
function fakeLoader(
  graph: ManagerGraph,
): ManagerGraphLoader & { loaded: () => number } {
  let count = 0;
  return {
    load: async () => {
      count += 1;
      return graph;
    },
    loaded: () => count,
  };
}

/** Locate a recorded call by a distinctive SQL fragment. */
function call(calls: RecordedCall[], match: RegExp): RecordedCall {
  const found = calls.find((c) => match.test(c.text));
  assert.ok(found, `expected a query matching ${match}`);
  return found;
}

/** The SQL fragments that uniquely identify the store's queries. */
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

describe('isTriageCompleteExcluded (R11.2 → R10.5)', () => {
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

// ── Hierarchy scoping (R11.1, R19) ──────────────────────────────────────────────

describe('DbTeamStatsStore — hierarchy scoping (R11.1, R19)', () => {
  it('resolves the downward hierarchy and binds that set with = ANY($1)', async () => {
    // 100 manages 2 and 3; 2 manages 4. Downward set of 100 = {2,3,4}. The root
    // (100) is NOT part of its own team.
    const loader = fakeLoader(graphOf({ 2: 100, 3: 100, 4: 2 }));
    const { db, calls } = fakeDb(emptyRoutes());
    const store = new DbTeamStatsStore(db, loader);

    await store.getTeamStats({ userId: 100, timezone: 'UTC' });

    assert.equal(loader.loaded(), 1, 'the hierarchy resolver is consulted once');
    // Every query binds the SAME resolved member set as its first parameter.
    for (const match of [STATUS_BY_MONTH, TYPE_COUNTS, TIME_BY_TYPE, STATUS_COUNTS]) {
      const c = call(calls, match);
      const bound = [...(c.params[0] as number[])].sort((a, b) => a - b);
      assert.deepEqual(bound, [2, 3, 4], `set bound for ${match}`);
      assert.match(c.text, /r\.raised_by_id = ANY\(\$1\)/);
    }
  });

  it('applies the area-manager cutoff: an area-manager report is included but not descended into (R19.2)', async () => {
    // 100 manages 2; 2 (area manager) manages 4. 2 is a genuine report so it is
    // in scope, but its sub-tree (4) is NOT absorbed into 100's team.
    const loader = fakeLoader(graphOf({ 2: 100, 4: 2 }, [2]));
    const { db, calls } = fakeDb(emptyRoutes());
    const store = new DbTeamStatsStore(db, loader);

    await store.getTeamStats({ userId: 100, timezone: 'UTC' });

    const c = call(calls, STATUS_BY_MONTH);
    assert.deepEqual([...(c.params[0] as number[])], [2]);
  });

  it('returns empty datasets and issues NO SQL when the hierarchy is empty (leaf manager)', async () => {
    // 100 manages no-one.
    const loader = fakeLoader(graphOf({ 5: 6 }));
    const { db, calls } = fakeDb(emptyRoutes());
    const store = new DbTeamStatsStore(db, loader);

    const view = await store.getTeamStats({ userId: 100, timezone: 'UTC' });

    assert.deepEqual(view, {
      statusByMonth: [],
      typeCounts: [],
      timeByType: [],
      summary: [],
    });
    assert.equal(loader.loaded(), 1);
    assert.equal(calls.length, 0, 'no aggregate SQL is issued for an empty scope');
  });

  it('terminates on a cyclic manager graph and still binds a finite set (R19.4)', async () => {
    // 100 → 2 → 3 → 100 (cycle back to the root). Must not loop; set = {2,3}.
    const loader = fakeLoader(graphOf({ 2: 100, 3: 2, 100: 3 }));
    const { db, calls } = fakeDb(emptyRoutes());
    const store = new DbTeamStatsStore(db, loader);

    await store.getTeamStats({ userId: 100, timezone: 'UTC' });

    const c = call(calls, STATUS_BY_MONTH);
    assert.deepEqual([...(c.params[0] as number[])].sort((a, b) => a - b), [2, 3]);
  });
});

// ── Status-by-month: timezone bucketing (R11.2 → R10.1, R18.3) ──────────────────

describe('DbTeamStatsStore — status-by-month timezone bucketing (R11.2 → R10.1, R18.3)', () => {
  it('binds the member set and IANA timezone as parameters and rebases with AT TIME ZONE $2', async () => {
    const routes = emptyRoutes();
    routes[0] = {
      match: STATUS_BY_MONTH,
      rows: [
        { month: '2026-01', status: 'NEW', count: 2 },
        { month: '2026-02', status: 'COMPLETE', count: 1 },
      ],
    };
    const loader = fakeLoader(graphOf({ 2: 100, 3: 100 }));
    const { db, calls } = fakeDb(routes);
    const store = new DbTeamStatsStore(db, loader);

    const view = await store.getTeamStats({ userId: 100, timezone: 'Europe/London' });

    const c = call(calls, STATUS_BY_MONTH);
    // The member set ($1) and timezone ($2) are the only bound values; neither
    // is interpolated into the SQL text (R22.2).
    assert.deepEqual([...(c.params[0] as number[])].sort((a, b) => a - b), [2, 3]);
    assert.equal(c.params[1], 'Europe/London');
    assert.ok(
      !c.text.includes('Europe/London'),
      'timezone must be bound, not interpolated',
    );
    assert.match(c.text, /AT TIME ZONE \$2/);
    assert.match(c.text, /r\.raised_by_id = ANY\(\$1\)/);

    // Rows map straight through to (month, status, count) buckets.
    assert.deepEqual(view.statusByMonth, [
      { month: '2026-01', status: 'NEW', count: 2 },
      { month: '2026-02', status: 'COMPLETE', count: 1 },
    ]);
  });

  it('same SQL, only the bound timezone differs between two viewers (R18.3)', async () => {
    // The rebasing lives in the SQL; prove two timezones produce IDENTICAL SQL
    // but DIFFERENT bound tz, which is what buckets a month-boundary timestamp
    // differently per zone.
    const utc = fakeDb(emptyRoutes());
    const tokyo = fakeDb(emptyRoutes());
    const loader = () => fakeLoader(graphOf({ 2: 100 }));

    await new DbTeamStatsStore(utc.db, loader()).getTeamStats({
      userId: 100,
      timezone: 'UTC',
    });
    await new DbTeamStatsStore(tokyo.db, loader()).getTeamStats({
      userId: 100,
      timezone: 'Asia/Tokyo',
    });

    const utcCall = call(utc.calls, STATUS_BY_MONTH);
    const tokyoCall = call(tokyo.calls, STATUS_BY_MONTH);
    assert.equal(utcCall.text, tokyoCall.text, 'same SQL, only the bound tz differs');
    assert.equal(utcCall.params[1], 'UTC');
    assert.equal(tokyoCall.params[1], 'Asia/Tokyo');
  });
});

// ── Type pies (R11 → R10.2, R10.3) ──────────────────────────────────────────────

describe('DbTeamStatsStore — type pies (R11 → R10.2, R10.3)', () => {
  it('maps the type-count pie and scopes to the member set', async () => {
    const routes = emptyRoutes();
    routes[4] = {
      match: TYPE_COUNTS,
      rows: [
        { task_id: 5, task_name: 'Access', count: '3' },
        { task_id: 6, task_name: 'Hardware', count: 1 },
      ],
    };
    const loader = fakeLoader(graphOf({ 2: 100, 3: 100 }));
    const { db, calls } = fakeDb(routes);
    const store = new DbTeamStatsStore(db, loader);

    const view = await store.getTeamStats({ userId: 100, timezone: 'UTC' });

    assert.deepEqual(view.typeCounts, [
      { taskId: 5, taskName: 'Access', count: 3 },
      { taskId: 6, taskName: 'Hardware', count: 1 },
    ]);
    const c = call(calls, TYPE_COUNTS);
    assert.deepEqual([...(c.params[0] as number[])].sort((a, b) => a - b), [2, 3]);
  });

  it('maps the time-by-type pie (COALESCEd minutes, member-scoped)', async () => {
    const routes = emptyRoutes();
    routes[3] = {
      match: TIME_BY_TYPE,
      rows: [
        { task_id: 5, task_name: 'Access', total_minutes: '120' },
        { task_id: 6, task_name: 'Hardware', total_minutes: 0 },
      ],
    };
    const loader = fakeLoader(graphOf({ 2: 100 }));
    const { db, calls } = fakeDb(routes);
    const store = new DbTeamStatsStore(db, loader);

    const view = await store.getTeamStats({ userId: 100, timezone: 'UTC' });

    assert.deepEqual(view.timeByType, [
      { taskId: 5, taskName: 'Access', totalMinutes: 120 },
      { taskId: 6, taskName: 'Hardware', totalMinutes: 0 },
    ]);
    const c = call(calls, TIME_BY_TYPE);
    assert.deepEqual([...(c.params[0] as number[])], [2]);
    // A LEFT JOIN keeps a type with no recorded slices in the result at 0.
    assert.match(c.text, /LEFT JOIN time_slice ts/);
  });
});

// ── Summary table + Rejected/Cancelled exclusion (R11.2 → R10.4, R10.5) ─────────

describe('DbTeamStatsStore — summary durations exclusion (R11.2 → R10.4, R10.5)', () => {
  it('binds member set + TRIAGE/COMPLETE/excluded statuses and applies the exclusion only to Triage→Complete', async () => {
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
    const loader = fakeLoader(graphOf({ 2: 100, 3: 100 }));
    const { db, calls } = fakeDb(routes);
    const store = new DbTeamStatsStore(db, loader);

    await store.getTeamStats({ userId: 100, timezone: 'UTC' });

    const c = call(calls, DURATIONS);
    // Params: member set, TRIAGE, COMPLETE, [REJECTED, CANCELLED] — all bound.
    assert.deepEqual([...(c.params[0] as number[])].sort((a, b) => a - b), [2, 3]);
    assert.equal(c.params[1], 'TRIAGE');
    assert.equal(c.params[2], 'COMPLETE');
    assert.deepEqual(c.params[3], ['REJECTED', 'CANCELLED']);
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
    const loader = fakeLoader(graphOf({ 2: 100 }));
    const { db } = fakeDb(routes);
    const store = new DbTeamStatsStore(db, loader);

    const view = await store.getTeamStats({ userId: 100, timezone: 'UTC' });

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
    const loader = fakeLoader(graphOf({ 2: 100 }));
    const { db } = fakeDb(routes);
    const store = new DbTeamStatsStore(db, loader);

    const view = await store.getTeamStats({ userId: 100, timezone: 'UTC' });

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
    const loader = fakeLoader(graphOf({ 2: 100 }));
    const { db } = fakeDb(routes);
    const store = new DbTeamStatsStore(db, loader);

    const view = await store.getTeamStats({ userId: 100, timezone: 'UTC' });

    assert.deepEqual(
      view.summary.map((r) => r.taskName),
      ['Hardware', 'Access', 'Billing'],
    );
  });
});
