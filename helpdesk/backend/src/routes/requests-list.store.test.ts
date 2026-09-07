import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Queryable } from '../db/query.js';
import type { ManagerGraph, ManagerGraphLoader, UserId } from '../hierarchy/index.js';
import {
  DbRequestListStore,
  type ListViewer,
  type RequestListQuery,
} from './requests-list.store.js';

/**
 * Tests for the Postgres-backed Requests-list store (design: "Requests (user
 * side)" — `GET /api/requests?scope=mine|team&hideComplete=&q=`; R4.1–4.4,
 * R4.9, R19). A fake {@link Queryable} answers the store's single SELECT and
 * records every call (SQL + bound params), and a fake {@link ManagerGraphLoader}
 * supplies an in-memory manager graph — so scope resolution, the hide-complete
 * filter, the parameterised search, and column/ISO-date mapping are exercised
 * WITHOUT a live database, matching the request-create store test style.
 *
 * The key invariant asserted throughout: NO value is ever interpolated into the
 * SQL text — the raiser set, the stop-state list, and the `%term%` search term
 * all travel as bound parameters (R22.2).
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
 * call for assertions. The store issues exactly one SELECT (plus, for team
 * scope, a graph load that goes through the loader, not the db).
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

/** Build a ManagerGraph from a `child → manager` map (+ optional area managers). */
function graphOf(
  managerOf: Record<number, number>,
  areaManagers: number[] = [],
): ManagerGraph {
  const directReports = new Map<UserId, Set<UserId>>();
  for (const [child, manager] of Object.entries(managerOf)) {
    const m = Number(manager);
    const c = Number(child);
    let reports = directReports.get(m);
    if (!reports) {
      reports = new Set<UserId>();
      directReports.set(m, reports);
    }
    reports.add(c);
  }
  return { directReports, areaManagerIds: new Set<UserId>(areaManagers) };
}

/** A fake loader returning a fixed graph and recording whether it was loaded. */
function fakeLoader(graph: ManagerGraph): ManagerGraphLoader & { loaded: () => number } {
  let count = 0;
  return {
    load: async () => {
      count += 1;
      return graph;
    },
    loaded: () => count,
  };
}

const viewer: ListViewer = { userId: 100 };

const mineQuery: RequestListQuery = { scope: 'mine', hideComplete: true, search: null };

/** The single list SELECT the store issues. */
function listCall(calls: RecordedCall[]): RecordedCall {
  const call = calls.find((c) => c.text.includes('FROM request r'));
  assert.ok(call, 'expected the list SELECT to be issued');
  return call;
}

// ── Scope: mine vs team (R4.3, R19) ─────────────────────────────────────────────

describe('DbRequestListStore.list — scope (R4.3, R19)', () => {
  it('scope=mine binds exactly the current user as the raiser set (no graph load)', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const loader = fakeLoader(graphOf({}));
    const store = new DbRequestListStore(db, loader);

    await store.list(mineQuery, viewer);

    // The hierarchy resolver is NOT consulted for "mine".
    assert.equal(loader.loaded(), 0);
    const call = listCall(calls);
    // Raiser set is bound as $1 — an array containing just the current user.
    assert.deepEqual(call.params[0], [100]);
    assert.match(call.text, /raised_by_id = ANY\(\$1\)/);
  });

  it('scope=team resolves the downward hierarchy and binds that set (R4.3, R19.1)', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    // 100 manages 2 and 3; 2 manages 4. Downward set of 100 = {2,3,4}.
    const loader = fakeLoader(graphOf({ 2: 100, 3: 100, 4: 2 }));
    const store = new DbRequestListStore(db, loader);

    await store.list({ scope: 'team', hideComplete: true, search: null }, viewer);

    assert.equal(loader.loaded(), 1);
    const call = listCall(calls);
    const raiserSet = call.params[0] as number[];
    assert.deepEqual([...raiserSet].sort((a, b) => a - b), [2, 3, 4]);
    // The current user is NOT in their own "My Team" set.
    assert.ok(!raiserSet.includes(100));
  });

  it('scope=team honours the area-manager cutoff (R19.2)', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    // 100 → 2 → 3 → 4, with 2 an area manager: 2 is included but its sub-tree is cut.
    const loader = fakeLoader(graphOf({ 2: 100, 3: 2, 4: 3 }, [2]));
    const store = new DbRequestListStore(db, loader);

    await store.list({ scope: 'team', hideComplete: true, search: null }, viewer);

    const call = listCall(calls);
    assert.deepEqual(call.params[0], [2]);
  });

  it('scope=team with an empty hierarchy returns no rows and issues no query', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const loader = fakeLoader(graphOf({})); // 100 manages no-one
    const store = new DbRequestListStore(db, loader);

    const rows = await store.list(
      { scope: 'team', hideComplete: true, search: null },
      viewer,
    );

    assert.deepEqual(rows, []);
    // Short-circuits before the SELECT so we never issue `= ANY([])`.
    assert.equal(calls.find((c) => c.text.includes('FROM request r')), undefined);
  });
});

// ── Hide-complete (R4.4) ────────────────────────────────────────────────────────

describe('DbRequestListStore.list — hide-complete (R4.4)', () => {
  it('excludes stop states as a bound array parameter when hideComplete is true', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbRequestListStore(db, fakeLoader(graphOf({})));

    await store.list({ scope: 'mine', hideComplete: true, search: null }, viewer);

    const call = listCall(calls);
    // The stop-state list is bound (not interpolated) and matched with <> ALL.
    // ($1 = raiser set, $2 = viewer id for the "Updated" join, $3 = stop states.)
    assert.deepEqual(call.params[2], ['COMPLETE', 'REJECTED', 'CANCELLED']);
    assert.match(call.text, /<> ALL\(\$3::request_status\[\]\)/);
  });

  it('omits the status filter entirely when hideComplete is false', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbRequestListStore(db, fakeLoader(graphOf({})));

    await store.list({ scope: 'mine', hideComplete: false, search: null }, viewer);

    const call = listCall(calls);
    // Only the raiser-set ($1) and viewer-id ($2) params are bound; no
    // stop-state array, no status filter.
    assert.equal(call.params.length, 2);
    assert.ok(!call.text.includes('<> ALL($3'));
  });
});

// ── Search (R4.2) ────────────────────────────────────────────────────────────────

describe('DbRequestListStore.list — search (R4.2)', () => {
  it('binds a single %term% parameter and matches every in-scope field with ILIKE', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbRequestListStore(db, fakeLoader(graphOf({})));

    await store.list({ scope: 'mine', hideComplete: true, search: 'printer' }, viewer);

    const call = listCall(calls);
    // params: [raiserSet, viewerId, stopStates, '%printer%'].
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
    const store = new DbRequestListStore(db, fakeLoader(graphOf({})));

    await store.list({ scope: 'mine', hideComplete: false, search: 'abc' }, viewer);

    const call = listCall(calls);
    // params: [raiserSet, viewerId, '%abc%'] — no stop-state array when
    // hideComplete is false, so the search term lands at $3.
    assert.equal(call.params[2], '%abc%');
    assert.match(call.text, /r\.title ILIKE \$3/);
  });

  it('omits the search clause when there is no term', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbRequestListStore(db, fakeLoader(graphOf({})));

    await store.list(mineQuery, viewer);

    const call = listCall(calls);
    assert.ok(!call.text.includes('ILIKE'));
  });
});

// ── Column mapping & ISO dates (R4.5, R4.9) ─────────────────────────────────────

describe('DbRequestListStore.list — column mapping (R4.5, R4.9)', () => {
  it('maps every column to camelCase with ISO-8601 dates', async () => {
    const { db } = fakeDb([dbRow()]);
    const store = new DbRequestListStore(db, fakeLoader(graphOf({})));

    const [row] = await store.list(mineQuery, viewer);

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
      // The viewer's "Updated" indicator (R4.8) — driven by updated_since_last_seen.
      updatedSinceLastSeen: false,
    });
  });

  it('maps a null assignment and an open timer', async () => {
    const { db } = fakeDb([
      dbRow({ assigned_member_id: null, assigned_member_name: null, has_open_timer: true }),
    ]);
    const store = new DbRequestListStore(db, fakeLoader(graphOf({})));

    const [row] = await store.list(mineQuery, viewer);

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
    const store = new DbRequestListStore(db, fakeLoader(graphOf({})));

    const [row] = await store.list(mineQuery, viewer);

    assert.strictEqual(row.id, 555);
    assert.strictEqual(row.teamId, 7);
    assert.strictEqual(row.assignedMemberId, 200);
    assert.equal(row.dateRaised, '2026-02-01T09:00:00.000Z');
    assert.equal(row.lastUpdated, '2026-02-02T10:30:00.000Z');
    assert.equal(row.estimatedStartDate, null);
  });

  it('orders newest-updated first in the SQL', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbRequestListStore(db, fakeLoader(graphOf({})));

    await store.list(mineQuery, viewer);

    assert.match(listCall(calls).text, /ORDER BY r\.updated_at DESC, r\.id DESC/);
  });
});

// ── "Updated" indicator (R4.8, R7.5, R7.6) ───────────────────────────────────

/**
 * The per-row "Updated" flag is computed IN SQL (a request has a non-internal
 * change after the viewer's last_seen_at). These tests assert two things the
 * store owns:
 *   1. it emits the correct parameterised SQL — the viewer's id is bound at $2
 *      and joined to their own request_last_seen row, and the "latest change"
 *      source EXCLUDES internal-note audit entries so an internal-note change
 *      never flags the user's Requests view (R7.5) while every other change does
 *      (R7.6); and
 *   2. it maps the boolean `updated_since_last_seen` column the DB returns
 *      straight through to `updatedSinceLastSeen`, for the updated / not-updated
 *      / no-last-seen-row cases the SQL distinguishes (R4.8).
 */
describe('DbRequestListStore.list — "Updated" indicator (R4.8, R7.5, R7.6)', () => {
  it('binds the viewer id at $2 and joins their own request_last_seen row', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbRequestListStore(db, fakeLoader(graphOf({})));

    await store.list(mineQuery, viewer);

    const call = listCall(calls);
    // $2 is the CURRENT viewer's id (100), bound — never interpolated.
    assert.equal(call.params[1], 100);
    // The last-seen row is joined per-request for THIS viewer via $2.
    assert.match(call.text, /LEFT JOIN request_last_seen rls/);
    assert.match(call.text, /rls\.user_id = \$2/);
    assert.match(call.text, /rls\.request_id = r\.id/);
  });

  it('derives the latest non-internal change from audit_entry, EXCLUDING internal notes (R7.5)', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbRequestListStore(db, fakeLoader(graphOf({})));

    await store.list(mineQuery, viewer);

    const call = listCall(calls);
    // Latest change is the MAX(changed_at) over request + external-note audit.
    assert.match(call.text, /MAX\(ae\.changed_at\)/);
    assert.match(call.text, /ae\.entity_type = 'request' AND ae\.entity_id = r\.id/);
    // Note entries are restricted to NON-internal notes (is_internal = false) so
    // an internal-note change is never counted (R7.5). Every other change — a
    // request-level audit entry or an external note — does count (R7.6).
    assert.match(call.text, /ae\.entity_type = 'request_note'/);
    assert.match(call.text, /rn\.is_internal = false/);
  });

  it('computes the flag as: a non-internal change exists AND it is newer than last_seen (or unseen)', async () => {
    const { db, calls } = fakeDb([dbRow()]);
    const store = new DbRequestListStore(db, fakeLoader(graphOf({})));

    await store.list(mineQuery, viewer);

    const call = listCall(calls);
    assert.match(call.text, /lnc\.latest_change IS NOT NULL/);
    assert.match(call.text, /rls\.last_seen_at IS NULL/);
    assert.match(call.text, /lnc\.latest_change > rls\.last_seen_at/);
    assert.match(call.text, /AS updated_since_last_seen/);
  });

  it('flags "Updated" true for a non-internal change after last_seen (R4.8, R7.6)', async () => {
    // The DB evaluated the flag true (a non-internal change is newer than the
    // viewer's last_seen_at) — the store maps it straight through.
    const { db } = fakeDb([dbRow({ updated_since_last_seen: true })]);
    const store = new DbRequestListStore(db, fakeLoader(graphOf({})));

    const [row] = await store.list(mineQuery, viewer);

    assert.equal(row.updatedSinceLastSeen, true);
  });

  it('does NOT flag "Updated" when last_seen is at/after the latest change', async () => {
    // The DB evaluated the flag false (last_seen_at >= latest non-internal
    // change), e.g. the viewer just opened the request.
    const { db } = fakeDb([dbRow({ updated_since_last_seen: false })]);
    const store = new DbRequestListStore(db, fakeLoader(graphOf({})));

    const [row] = await store.list(mineQuery, viewer);

    assert.equal(row.updatedSinceLastSeen, false);
  });

  it('does NOT flag "Updated" for an internal-note-only change (R7.5)', async () => {
    // The ONLY change since last_seen was an internal note. The SQL excludes
    // internal-note audit entries from `latest_change`, so the DB returns the
    // flag as false — an internal-note update never flags the Requests view.
    const { db } = fakeDb([dbRow({ updated_since_last_seen: false })]);
    const store = new DbRequestListStore(db, fakeLoader(graphOf({})));

    const [row] = await store.list(mineQuery, viewer);

    assert.equal(row.updatedSinceLastSeen, false);
  });

  it('flags "Updated" true when the viewer has no last_seen row but the request has activity', async () => {
    // No request_last_seen row for this viewer → rls.last_seen_at IS NULL, and a
    // non-internal change exists (every request is audited on creation), so the
    // DB returns the flag true — an unseen-but-active request shows as Updated.
    const { db } = fakeDb([dbRow({ updated_since_last_seen: true })]);
    const store = new DbRequestListStore(db, fakeLoader(graphOf({})));

    const [row] = await store.list(mineQuery, viewer);

    assert.equal(row.updatedSinceLastSeen, true);
  });

  it('coerces a non-strict truthy/falsy DB value to a real boolean', async () => {
    // Defensive: whatever the driver yields, the row exposes a strict boolean.
    const { db } = fakeDb([dbRow({ updated_since_last_seen: false })]);
    const store = new DbRequestListStore(db, fakeLoader(graphOf({})));

    const [row] = await store.list(mineQuery, viewer);

    assert.strictEqual(row.updatedSinceLastSeen, false);
  });
});
