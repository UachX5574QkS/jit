import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Queryable } from '../db/query.js';
import {
  DbSupportStatsStore,
  isAcceptedCompleteExcluded,
  emptySupportStatsView,
  ACCEPTED_COMPLETE_EXCLUDED,
} from './stats-support.store.js';

/**
 * Tests for the Postgres-backed Support-Statistics store (design: "Statistics" —
 * `GET /api/stats/support`; R12). A fake {@link Queryable} answers each SELECT
 * from a response keyed on a distinctive fragment of the SQL (the store issues
 * them concurrently via Promise.all, so responses are matched by content, not
 * call order) and records every call (SQL + bound params). Together they pin
 * down:
 *   • the team scope is bound as ONE array parameter matched with `= ANY($1)`
 *     for both `request.team_id` and `team_member.team_id` (R12.1);
 *   • an empty team scope short-circuits to empty datasets and issues NO SQL;
 *   • the status-by-month SQL binds the tz as $2 and rebases with
 *     `AT TIME ZONE $2` (R12.2 → R18.3) — never interpolated;
 *   • the members query returns every member of the scoped teams (columns);
 *   • the assigned-count query groups by (task, assigned member) regardless of
 *     status and drops unassigned requests (R12.3);
 *   • the Accepted→Complete duration query binds ACCEPTED/COMPLETE/excluded
 *     statuses and applies the Rejected/Cancelled exclusion (R12.4), with the
 *     transition moments coming from status audit entries (R22.2).
 * The pure helpers are also unit-tested directly.
 */

interface RecordedCall {
  readonly text: string;
  readonly params: readonly unknown[];
}

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

function call(calls: RecordedCall[], match: RegExp): RecordedCall {
  const found = calls.find((c) => match.test(c.text));
  assert.ok(found, `expected a query matching ${match}`);
  return found;
}

/** The SQL fragments that uniquely identify the store's queries. */
const STATUS_BY_MONTH = /date_trunc\('month'/;
const MEMBERS = /FROM team_member tm/;
const TASK_ROWS = /FROM task t\s+JOIN team tm/;
const ASSIGNED_COUNTS = /GROUP BY t\.id, r\.assigned_member_id/;
const DURATIONS = /avg_accepted_to_complete_seconds/;

/** A full route table returning empty rows for every query (override per test). */
function emptyRoutes(): Array<{ match: RegExp; rows: unknown[] }> {
  return [
    { match: STATUS_BY_MONTH, rows: [] },
    { match: MEMBERS, rows: [] },
    { match: TASK_ROWS, rows: [] },
    { match: ASSIGNED_COUNTS, rows: [] },
    { match: DURATIONS, rows: [] },
  ];
}

// ── Pure helpers ────────────────────────────────────────────────────────────────

describe('isAcceptedCompleteExcluded (R12.4)', () => {
  it('excludes REJECTED and CANCELLED', () => {
    assert.equal(isAcceptedCompleteExcluded('REJECTED'), true);
    assert.equal(isAcceptedCompleteExcluded('CANCELLED'), true);
  });
  it('does not exclude COMPLETE or any active status', () => {
    assert.equal(isAcceptedCompleteExcluded('COMPLETE'), false);
    assert.equal(isAcceptedCompleteExcluded('ACCEPTED'), false);
    assert.equal(isAcceptedCompleteExcluded('ACTIVE'), false);
  });
});

describe('emptySupportStatsView', () => {
  it('is empty in every dataset', () => {
    assert.deepEqual(emptySupportStatsView(), {
      statusByMonth: [],
      members: [],
      rows: [],
      assignedCounts: [],
      avgAcceptedToComplete: [],
    });
  });
});

// ── Team scoping (R12.1) ────────────────────────────────────────────────────────

describe('DbSupportStatsStore — team scoping (R12.1)', () => {
  it('returns empty datasets and issues NO SQL for an empty team scope', async () => {
    const { db, calls } = fakeDb(emptyRoutes());
    const store = new DbSupportStatsStore(db);

    const view = await store.getSupportStats({ teamIds: [], timezone: 'UTC' });

    assert.deepEqual(view, emptySupportStatsView());
    assert.equal(calls.length, 0, 'no SQL is issued for an empty team scope');
  });

  it('binds the team set with = ANY($1) for request and team_member queries', async () => {
    const { db, calls } = fakeDb(emptyRoutes());
    const store = new DbSupportStatsStore(db);

    await store.getSupportStats({ teamIds: [7, 9], timezone: 'UTC' });

    for (const match of [STATUS_BY_MONTH, ASSIGNED_COUNTS]) {
      const c = call(calls, match);
      assert.deepEqual([...(c.params[0] as number[])].sort((a, b) => a - b), [7, 9]);
      assert.match(c.text, /r\.team_id = ANY\(\$1\)/);
    }
    // The members query scopes on team_member.team_id, not request.team_id.
    const members = call(calls, MEMBERS);
    assert.deepEqual([...(members.params[0] as number[])].sort((a, b) => a - b), [7, 9]);
    assert.match(members.text, /tm\.team_id = ANY\(\$1\)/);
  });
});

// ── Status-by-month: timezone bucketing (R12.2 → R18.3) ─────────────────────────

describe('DbSupportStatsStore — status-by-month timezone bucketing (R12.2 → R18.3)', () => {
  it('binds the team set and IANA timezone and rebases with AT TIME ZONE $2', async () => {
    const routes = emptyRoutes();
    routes[0] = {
      match: STATUS_BY_MONTH,
      rows: [
        { month: '2026-01', status: 'NEW', count: 2 },
        { month: '2026-02', status: 'COMPLETE', count: 1 },
      ],
    };
    const { db, calls } = fakeDb(routes);
    const store = new DbSupportStatsStore(db);

    const view = await store.getSupportStats({ teamIds: [7], timezone: 'Europe/London' });

    const c = call(calls, STATUS_BY_MONTH);
    assert.deepEqual([...(c.params[0] as number[])], [7]);
    assert.equal(c.params[1], 'Europe/London');
    assert.ok(!c.text.includes('Europe/London'), 'tz must be bound, not interpolated');
    assert.match(c.text, /AT TIME ZONE \$2/);

    assert.deepEqual(view.statusByMonth, [
      { month: '2026-01', status: 'NEW', count: 2 },
      { month: '2026-02', status: 'COMPLETE', count: 1 },
    ]);
  });

  it('same SQL, only the bound timezone differs between two viewers (R18.3)', async () => {
    const utc = fakeDb(emptyRoutes());
    const tokyo = fakeDb(emptyRoutes());

    await new DbSupportStatsStore(utc.db).getSupportStats({ teamIds: [7], timezone: 'UTC' });
    await new DbSupportStatsStore(tokyo.db).getSupportStats({
      teamIds: [7],
      timezone: 'Asia/Tokyo',
    });

    const utcCall = call(utc.calls, STATUS_BY_MONTH);
    const tokyoCall = call(tokyo.calls, STATUS_BY_MONTH);
    assert.equal(utcCall.text, tokyoCall.text, 'same SQL, only the bound tz differs');
    assert.equal(utcCall.params[1], 'UTC');
    assert.equal(tokyoCall.params[1], 'Asia/Tokyo');
  });
});

// ── Members + rows (the shared table dimensions, R12.3/R12.4) ───────────────────

describe('DbSupportStatsStore — members and rows', () => {
  it('maps team members into columns and task types into rows', async () => {
    const routes = emptyRoutes();
    routes[1] = {
      match: MEMBERS,
      rows: [
        { member_id: '10', member_name: 'Alice Smith' },
        { member_id: 11, member_name: 'Bob Jones' },
      ],
    };
    routes[2] = {
      match: TASK_ROWS,
      rows: [
        { task_id: '5', task_name: 'Access', team_id: '7', team_title: 'Platform' },
        { task_id: 6, task_name: 'Hardware', team_id: 7, team_title: 'Platform' },
      ],
    };
    const { db } = fakeDb(routes);
    const store = new DbSupportStatsStore(db);

    const view = await store.getSupportStats({ teamIds: [7], timezone: 'UTC' });

    assert.deepEqual(view.members, [
      { memberId: 10, memberName: 'Alice Smith' },
      { memberId: 11, memberName: 'Bob Jones' },
    ]);
    assert.deepEqual(view.rows, [
      { taskId: 5, taskName: 'Access', teamId: 7, teamTitle: 'Platform' },
      { taskId: 6, taskName: 'Hardware', teamId: 7, teamTitle: 'Platform' },
    ]);
  });
});

// ── Assigned-count table (R12.3) ────────────────────────────────────────────────

describe('DbSupportStatsStore — assigned-count table (R12.3)', () => {
  it('groups by (task, assigned member) regardless of status and drops unassigned', async () => {
    const routes = emptyRoutes();
    routes[3] = {
      match: ASSIGNED_COUNTS,
      rows: [
        { task_id: 5, member_id: 10, count: '3' },
        { task_id: 6, member_id: 11, count: 1 },
      ],
    };
    const { db, calls } = fakeDb(routes);
    const store = new DbSupportStatsStore(db);

    const view = await store.getSupportStats({ teamIds: [7], timezone: 'UTC' });

    assert.deepEqual(view.assignedCounts, [
      { taskId: 5, memberId: 10, count: 3 },
      { taskId: 6, memberId: 11, count: 1 },
    ]);
    const c = call(calls, ASSIGNED_COUNTS);
    // Unassigned requests are excluded (they cannot belong to a member column).
    assert.match(c.text, /r\.assigned_member_id IS NOT NULL/);
    // No status filter here — the cell counts requests REGARDLESS of status.
    assert.ok(!/r\.status/.test(c.text), 'assigned counts must not filter on status');
  });
});

// ── Accepted→Complete average-duration table (R12.4) ────────────────────────────

describe('DbSupportStatsStore — Accepted→Complete durations (R12.4)', () => {
  it('binds team set + ACCEPTED/COMPLETE/excluded statuses and applies the exclusion', async () => {
    const routes = emptyRoutes();
    routes[4] = {
      match: DURATIONS,
      rows: [
        { task_id: 5, member_id: 10, avg_accepted_to_complete_seconds: '7200' },
      ],
    };
    const { db, calls } = fakeDb(routes);
    const store = new DbSupportStatsStore(db);

    const view = await store.getSupportStats({ teamIds: [7], timezone: 'UTC' });

    assert.deepEqual(view.avgAcceptedToComplete, [
      { taskId: 5, memberId: 10, avgAcceptedToCompleteSeconds: 7200 },
    ]);

    const c = call(calls, DURATIONS);
    assert.deepEqual([...(c.params[0] as number[])], [7]);
    assert.equal(c.params[1], 'ACCEPTED');
    assert.equal(c.params[2], 'COMPLETE');
    assert.deepEqual(c.params[3], ['REJECTED', 'CANCELLED']);
    assert.deepEqual([...ACCEPTED_COMPLETE_EXCLUDED], ['REJECTED', 'CANCELLED']);
    // Nothing interpolated (R22.2).
    assert.ok(!c.text.includes("'ACCEPTED'"), 'ACCEPTED must be bound, not interpolated');
    assert.ok(!c.text.includes("'COMPLETE'"), 'COMPLETE must be bound, not interpolated');
    assert.ok(
      !c.text.includes("'REJECTED'") && !c.text.includes("'CANCELLED'"),
      'excluded statuses must be bound, not interpolated',
    );
    // The exclusion is applied via the bound stop-status array.
    assert.match(c.text, /m\.status <> ALL\(\$4::text\[\]\)/);
    // Transition moments come from status audit entries.
    assert.match(c.text, /ae\.field_name = 'status'/);
    assert.match(c.text, /ae\.new_value = \$2/);
    assert.match(c.text, /ae\.new_value = \$3/);
    // Only assigned requests contribute a cell.
    assert.match(c.text, /r\.assigned_member_id IS NOT NULL/);
  });

  it('carries a null average through (no qualifying request)', async () => {
    const routes = emptyRoutes();
    routes[4] = {
      match: DURATIONS,
      rows: [
        { task_id: 5, member_id: 10, avg_accepted_to_complete_seconds: null },
      ],
    };
    const { db } = fakeDb(routes);
    const store = new DbSupportStatsStore(db);

    const view = await store.getSupportStats({ teamIds: [7], timezone: 'UTC' });

    assert.deepEqual(view.avgAcceptedToComplete, [
      { taskId: 5, memberId: 10, avgAcceptedToCompleteSeconds: null },
    ]);
  });
});
