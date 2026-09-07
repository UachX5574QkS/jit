import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Queryable } from '../db/query.js';
import {
  DbSupportListStore,
  type SupportListQuery,
  type SupportListViewer,
} from './support-list.store.js';

/**
 * Tests for the Postgres-backed Support-list store (design: "Support side" —
 * `GET /api/support/requests?team=&scope=mine|team&hideComplete=&
 * showUnassigned=&q=`; R6). A fake {@link Queryable} answers the store's single
 * SELECT and records every call (SQL + bound params) — so team scoping,
 * mine/team-queue, the hide-complete and show-unassigned filters, the
 * parameterised search, and column/ISO-date mapping are exercised WITHOUT a
 * live database, matching the requests-list store test style.
 *
 * The key invariant asserted throughout: NO value is ever interpolated into the
 * SQL text — the team scope, the current user id, the stop-state list, and the
 * `%term%` search term all travel as bound parameters (R22.2).
 */

interface RecordedCall {
  readonly text: string;
  readonly params: readonly unknown[];
}

/** One request row as the store's SELECT ... AS aliases yield it. */
function dbRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 555,
    task_reference: 'REQ-ABC-000001',
    jira_number: 'J-1',
    title: 'Broken printer',
    created_at: new Date('2026-02-01T09:00:00.000Z'),
    status: 'NEW',
    team_id: 7,
    team_title: 'Platform',
    assigned_member_id: 200,
    assigned_member_name: 'Jane Doe',
    updated_at: new Date('2026-02-02T10:30:00.000Z'),
    estimated_start_date: new Date('2026-02-05T00:00:00.000Z'),
    actual_start_date: null,
    has_open_timer: false,
    updated_since_last_seen: false,
    ...overrides,
  };
}

/**
 * A fake queryable that returns `rows` for the list SELECT and records every
 * call for assertions. The store issues exactly one SELECT.
 */
function fakeDb(rows: unknown[]): { db: Queryable; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const db = {
    query: async (text: string, params?: unknown[]) => {
      const bound = params ?? [];
      calls.push({ text, params: bound });
      return { rows, rowCount: rows.length } as never;
    },
  } as unknown as Queryable;
  return { db, calls };
}

/** The support user: id 100, member of teams 7 and 8. */
const viewer: SupportListViewer = { userId: 100, teamIds: [7, 8] };

const mineQuery: SupportListQuery = {
  scope: 'mine',
  hideComplete: true,
  showUnassigned: true,
  search: null,
};

const teamQuery: SupportListQuery = {
  scope: 'team',
  hideComplete: true,
  showUnassigned: true,
  search: null,
};

/** The single list SELECT the store issues. */
function listCall(calls: RecordedCall[]): RecordedCall {
  const call = calls.find((c) => c.text.includes('FROM request r'));
  assert.ok(call, 'expected the list SELECT to be issued');
  return call;
}

// ── Team drop-down scope (R6.3) ─────────────────────────────────────────────────

describe('DbSupportListStore.list — team scope (R6.3)', () => {
  it('binds the team scope as a single array parameter matched with = ANY($1)', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbSupportListStore(db);

    await store.list(teamQuery, viewer);

    const call = listCall(calls);
    // $1 is the team scope (all the user's teams here) — bound, never interpolated.
    assert.deepEqual(call.params[0], [7, 8]);
    assert.match(call.text, /r\.team_id = ANY\(\$1\)/);
  });

  it('scopes to a single team when only one team id is supplied', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbSupportListStore(db);

    await store.list(teamQuery, { userId: 100, teamIds: [8] });

    assert.deepEqual(listCall(calls).params[0], [8]);
  });

  it('returns no rows and issues no query when the team scope is empty', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbSupportListStore(db);

    const rows = await store.list(teamQuery, { userId: 100, teamIds: [] });

    assert.deepEqual(rows, []);
    // Short-circuits before the SELECT so we never issue `= ANY([])`.
    assert.equal(calls.find((c) => c.text.includes('FROM request r')), undefined);
  });
});

// ── My Queue vs Team Queue (R6.4) ───────────────────────────────────────────────

describe('DbSupportListStore.list — scope mine|team (R6.4)', () => {
  it('scope=mine filters to requests assigned to the current user ($2)', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbSupportListStore(db);

    await store.list(mineQuery, viewer);

    const call = listCall(calls);
    // $2 is the current user's id (100), bound — used by the My-Queue filter.
    assert.equal(call.params[1], 100);
    assert.match(call.text, /r\.assigned_member_id = \$2/);
  });

  it('scope=team does NOT constrain by assignment (shows the whole team queue)', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbSupportListStore(db);

    await store.list(teamQuery, viewer);

    const call = listCall(calls);
    assert.ok(!call.text.includes('r.assigned_member_id = $2'));
  });
});

// ── Hide-complete (R6.5) ────────────────────────────────────────────────────────

describe('DbSupportListStore.list — hide-complete (R6.5)', () => {
  it('excludes stop states as a bound array parameter when hideComplete is true', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbSupportListStore(db);

    await store.list(teamQuery, viewer);

    const call = listCall(calls);
    // ($1 = team scope, $2 = user id, $3 = stop states.)
    assert.deepEqual(call.params[2], ['COMPLETE', 'CANCELLED', 'REJECTED']);
    assert.match(call.text, /<> ALL\(\$3::request_status\[\]\)/);
  });

  it('omits the status filter entirely when hideComplete is false', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbSupportListStore(db);

    await store.list(
      { scope: 'team', hideComplete: false, showUnassigned: true, search: null },
      viewer,
    );

    const call = listCall(calls);
    // Only the team scope ($1) and user id ($2) are bound; no stop-state array.
    assert.equal(call.params.length, 2);
    assert.ok(!call.text.includes('<> ALL($3'));
  });
});

// ── Show-unassigned (R6.6) ──────────────────────────────────────────────────────

describe('DbSupportListStore.list — show-unassigned (R6.6)', () => {
  it('includes unassigned requests by default (no assignment predicate added)', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbSupportListStore(db);

    await store.list(teamQuery, viewer); // showUnassigned: true

    const call = listCall(calls);
    assert.ok(!call.text.includes('r.assigned_member_id IS NOT NULL'));
  });

  it('excludes unassigned requests when showUnassigned is false', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbSupportListStore(db);

    await store.list(
      { scope: 'team', hideComplete: true, showUnassigned: false, search: null },
      viewer,
    );

    const call = listCall(calls);
    assert.match(call.text, /r\.assigned_member_id IS NOT NULL/);
  });

  it('honours showUnassigned=false in My Queue too (consistent, though moot there)', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbSupportListStore(db);

    await store.list(
      { scope: 'mine', hideComplete: true, showUnassigned: false, search: null },
      viewer,
    );

    const call = listCall(calls);
    // Both the My-Queue assignment filter and the show-unassigned predicate apply.
    assert.match(call.text, /r\.assigned_member_id = \$2/);
    assert.match(call.text, /r\.assigned_member_id IS NOT NULL/);
  });
});

// ── Search (R6.2) ────────────────────────────────────────────────────────────────

describe('DbSupportListStore.list — search (R6.2)', () => {
  it('binds a single %term% parameter and matches every in-scope field with ILIKE', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbSupportListStore(db);

    await store.list(
      { scope: 'team', hideComplete: true, showUnassigned: true, search: 'printer' },
      viewer,
    );

    const call = listCall(calls);
    // params: [teamScope, userId, stopStates, '%printer%'].
    assert.equal(call.params[3], '%printer%');
    // The term is bound as $4 and reused across the OR-group — never interpolated.
    assert.ok(!call.text.includes('printer'));
    assert.match(call.text, /r\.task_reference ILIKE \$4/);
    assert.match(call.text, /r\.jira_number ILIKE \$4/);
    assert.match(call.text, /r\.title ILIKE \$4/);
    assert.match(call.text, /r\.status::text ILIKE \$4/);
    assert.match(call.text, /tm\.title ILIKE \$4/);
    assert.match(call.text, /first_name \|\| ' ' \|\| am\.surname\) ILIKE \$4/);
  });

  it('places the search term at $3 when hideComplete is false (param indices track)', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbSupportListStore(db);

    await store.list(
      { scope: 'team', hideComplete: false, showUnassigned: true, search: 'abc' },
      viewer,
    );

    const call = listCall(calls);
    // params: [teamScope, userId, '%abc%'] — no stop-state array when
    // hideComplete is false, so the search term lands at $3.
    assert.equal(call.params[2], '%abc%');
    assert.match(call.text, /r\.title ILIKE \$3/);
  });

  it('omits the search clause when there is no term', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbSupportListStore(db);

    await store.list(teamQuery, viewer);

    const call = listCall(calls);
    assert.ok(!call.text.includes('ILIKE'));
  });
});

// ── Column mapping & ISO dates (R6.7 — same columns as the Requests screen) ─────

describe('DbSupportListStore.list — column mapping (R6.7, R4.5, R4.9)', () => {
  it('maps every column to camelCase with ISO-8601 dates', async () => {
    const { db } = fakeDb([dbRow()]);
    const store = new DbSupportListStore(db);

    const [row] = await store.list(teamQuery, viewer);

    assert.deepEqual(row, {
      id: 555,
      taskReference: 'REQ-ABC-000001',
      jiraNumber: 'J-1',
      title: 'Broken printer',
      dateRaised: '2026-02-01T09:00:00.000Z',
      status: 'NEW',
      teamId: 7,
      teamTitle: 'Platform',
      assignedMemberId: 200,
      assignedMemberName: 'Jane Doe',
      lastUpdated: '2026-02-02T10:30:00.000Z',
      estimatedStartDate: '2026-02-05T00:00:00.000Z',
      actualStartDate: null,
      hasOpenTimer: false,
      // Owned by task 6.7 — left null here.
      estimatedEffortMinutes: null,
      // The support user's "Updated" indicator (R4.8).
      updatedSinceLastSeen: false,
    });
  });

  it('maps a null assignment and an open timer', async () => {
    const { db } = fakeDb([
      dbRow({ assigned_member_id: null, assigned_member_name: null, has_open_timer: true }),
    ]);
    const store = new DbSupportListStore(db);

    const [row] = await store.list(teamQuery, viewer);

    assert.equal(row.assignedMemberId, null);
    assert.equal(row.assignedMemberName, null);
    assert.equal(row.hasOpenTimer, true);
  });

  it('coerces string ids/dates (pg row shape) into numbers/ISO strings', async () => {
    const { db } = fakeDb([
      dbRow({
        id: '555',
        team_id: '7',
        assigned_member_id: '200',
        created_at: '2026-02-01T09:00:00.000Z',
        updated_at: '2026-02-02T10:30:00.000Z',
        estimated_start_date: null,
      }),
    ]);
    const store = new DbSupportListStore(db);

    const [row] = await store.list(teamQuery, viewer);

    assert.strictEqual(row.id, 555);
    assert.strictEqual(row.teamId, 7);
    assert.strictEqual(row.assignedMemberId, 200);
    assert.equal(row.dateRaised, '2026-02-01T09:00:00.000Z');
    assert.equal(row.lastUpdated, '2026-02-02T10:30:00.000Z');
    assert.equal(row.estimatedStartDate, null);
  });

  it('orders newest-updated first in the SQL', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbSupportListStore(db);

    await store.list(teamQuery, viewer);

    assert.match(listCall(calls).text, /ORDER BY r\.updated_at DESC, r\.id DESC/);
  });
});

// ── "Updated" indicator, computed for the current support user (R4.8, R7.5, R7.6) ──

describe('DbSupportListStore.list — "Updated" indicator (R4.8, R7.5, R7.6)', () => {
  it('binds the support user id at $2 and joins their own request_last_seen row', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbSupportListStore(db);

    await store.list(teamQuery, viewer);

    const call = listCall(calls);
    assert.equal(call.params[1], 100);
    assert.match(call.text, /LEFT JOIN request_last_seen rls/);
    assert.match(call.text, /rls\.user_id = \$2/);
    assert.match(call.text, /rls\.request_id = r\.id/);
  });

  it('derives the latest non-internal change from audit_entry, EXCLUDING internal notes (R7.5)', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbSupportListStore(db);

    await store.list(teamQuery, viewer);

    const call = listCall(calls);
    assert.match(call.text, /MAX\(ae\.changed_at\)/);
    assert.match(call.text, /ae\.entity_type = 'request' AND ae\.entity_id = r\.id/);
    assert.match(call.text, /ae\.entity_type = 'request_note'/);
    assert.match(call.text, /rn\.is_internal = false/);
  });

  it('computes the flag as: a non-internal change exists AND it is newer than last_seen (or unseen)', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbSupportListStore(db);

    await store.list(teamQuery, viewer);

    const call = listCall(calls);
    assert.match(call.text, /lnc\.latest_change IS NOT NULL/);
    assert.match(call.text, /rls\.last_seen_at IS NULL/);
    assert.match(call.text, /lnc\.latest_change > rls\.last_seen_at/);
    assert.match(call.text, /AS updated_since_last_seen/);
  });

  it('maps the boolean straight through (true / false)', async () => {
    const store1 = new DbSupportListStore(fakeDb([dbRow({ updated_since_last_seen: true })]).db);
    const store2 = new DbSupportListStore(fakeDb([dbRow({ updated_since_last_seen: false })]).db);

    const [updated] = await store1.list(teamQuery, viewer);
    const [notUpdated] = await store2.list(teamQuery, viewer);

    assert.strictEqual(updated.updatedSinceLastSeen, true);
    assert.strictEqual(notUpdated.updatedSinceLastSeen, false);
  });
});
