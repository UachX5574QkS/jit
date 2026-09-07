import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Queryable } from '../db/query.js';
import { AuditWriter } from '../audit/index.js';
import {
  DbTeamAdminStore,
  OpenRequestsConflictError,
  TeamNotFoundError,
  type TransactionRunner,
} from './team-admin.store.js';

/**
 * Tests for the Postgres-backed team-admin store (design: "Administration",
 * R13, R20.2, R17). A fake {@link Queryable} answers the store's SELECT/INSERT/
 * UPDATE statements and records every call, and the transaction runner is a
 * pass-through that hands that fake queryable to the store — so the guard SQL
 * (R20.2), the mutation, and the column-level audit writes (R17) are exercised
 * end to end WITHOUT a live database, matching the audit-writer test style.
 *
 * The fake keys its responses off a fragment of each SQL statement (INSERT /
 * SELECT ... FOR UPDATE / COUNT(*) / UPDATE) rather than the exact text, so the
 * tests assert behaviour (which statements ran, with which bound params) rather
 * than pinning to whitespace.
 */

interface RecordedCall {
  readonly text: string;
  readonly params: readonly unknown[];
}

/** A snake_case team row as the DB would return it. */
function dbTeam(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    title: 'Payments',
    description: null,
    team_leader_id: 100,
    is_closed: false,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/**
 * A fake queryable + a pass-through transaction runner. `responder` returns the
 * rows for a given statement; `calls` records everything for assertions. The
 * runner simply invokes `fn` with the fake db (no BEGIN/COMMIT needed for the
 * behaviour under test — the store's logic is what we exercise).
 */
function fakeDb(responder: (text: string, params: readonly unknown[]) => unknown[]): {
  db: Queryable;
  runTransaction: TransactionRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const db = {
    query: async (text: string, params?: unknown[]) => {
      const bound = params ?? [];
      calls.push({ text, params: bound });
      return { rows: responder(text, bound), rowCount: 0 } as never;
    },
  } as unknown as Queryable;
  const runTransaction: TransactionRunner = (fn) => fn(db);
  return { db, runTransaction, calls };
}

/** Find a recorded call whose SQL contains `fragment`. */
function callWith(calls: RecordedCall[], fragment: string): RecordedCall | undefined {
  return calls.find((c) => c.text.includes(fragment));
}

describe('DbTeamAdminStore.create (R13.2, R17)', () => {
  it('inserts the team with bound params and writes creation audit in the same tx', async () => {
    const { db, runTransaction, calls } = fakeDb((text) => {
      if (text.includes('INSERT INTO team')) {
        return [dbTeam({ id: 5, title: 'Payments', team_leader_id: 100 })];
      }
      return []; // audit INSERTs return nothing
    });
    const store = new DbTeamAdminStore(new AuditWriter(db), runTransaction);

    const row = await store.create(
      { title: 'Payments', description: null, teamLeaderId: 100 },
      777,
    );

    assert.equal(row.id, 5);
    assert.equal(row.title, 'Payments');
    assert.equal(row.teamLeaderId, 100);
    assert.equal(row.isClosed, false);

    // The team INSERT bound the values (no interpolation).
    const insert = callWith(calls, 'INSERT INTO team');
    assert.ok(insert);
    assert.deepEqual(insert.params, ['Payments', null, 100]);

    // Column-level audit rows were written for the created team's fields (R17),
    // carrying the acting admin id (777) and the entity id (5).
    const auditCalls = calls.filter((c) => c.text.includes('INSERT INTO audit_entry'));
    assert.ok(auditCalls.length >= 1, 'at least one audit row written');
    for (const c of auditCalls) {
      assert.equal(c.params[0], 'team'); // entity_type
      assert.equal(c.params[1], 5); // entity_id
      assert.equal(c.params[5], 777); // changed_by_id
    }
  });
});

describe('DbTeamAdminStore.update — change leader (R13.3, R17)', () => {
  it('updates the leader and audits only the changed column', async () => {
    const { db, runTransaction, calls } = fakeDb((text) => {
      if (text.includes('FOR UPDATE')) {
        return [dbTeam({ id: 1, team_leader_id: 100, is_closed: false })];
      }
      if (text.includes('UPDATE team')) {
        return [dbTeam({ id: 1, team_leader_id: 200, is_closed: false })];
      }
      return [];
    });
    const store = new DbTeamAdminStore(new AuditWriter(db), runTransaction);

    const row = await store.update(1, { teamLeaderId: 200 }, 500);
    assert.equal(row.teamLeaderId, 200);

    // No open-request count is needed when we are not closing the team.
    assert.equal(callWith(calls, 'COUNT(*)'), undefined);

    // Exactly one audit row — team_leader_id changed 100 → 200 (R17.2).
    const auditCalls = calls.filter((c) => c.text.includes('INSERT INTO audit_entry'));
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0].params[2], 'team_leader_id'); // field_name
    assert.equal(auditCalls[0].params[3], '100'); // old_value
    assert.equal(auditCalls[0].params[4], '200'); // new_value
  });

  it('throws TeamNotFoundError for an unknown id (no update runs)', async () => {
    const { db, runTransaction, calls } = fakeDb(() => []); // SELECT finds nothing
    const store = new DbTeamAdminStore(new AuditWriter(db), runTransaction);

    await assert.rejects(
      () => store.update(999, { teamLeaderId: 1 }, 500),
      (e) => e instanceof TeamNotFoundError,
    );
    assert.equal(callWith(calls, 'UPDATE team'), undefined);
  });
});

describe('DbTeamAdminStore.update — close guarded by open requests (R20.2)', () => {
  it('closes the team when it has zero non-closed requests', async () => {
    const { db, runTransaction, calls } = fakeDb((text) => {
      if (text.includes('FOR UPDATE')) {
        return [dbTeam({ id: 1, is_closed: false })];
      }
      if (text.includes('COUNT(*)')) {
        return [{ open_count: 0 }];
      }
      if (text.includes('UPDATE team')) {
        return [dbTeam({ id: 1, is_closed: true })];
      }
      return [];
    });
    const store = new DbTeamAdminStore(new AuditWriter(db), runTransaction);

    const row = await store.update(1, { isClosed: true }, 500);
    assert.equal(row.isClosed, true);

    // The guard consulted the request table, scoped to this team, and excluded
    // the stop states via a bound array (parameterised, not interpolated).
    const count = callWith(calls, 'COUNT(*)');
    assert.ok(count);
    assert.equal(count.params[0], 1); // team_id bound
    assert.deepEqual(count.params[1], ['REJECTED', 'CANCELLED', 'COMPLETE']);

    // The update ran and is_closed = true was audited.
    assert.ok(callWith(calls, 'UPDATE team'));
    const auditCalls = calls.filter((c) => c.text.includes('INSERT INTO audit_entry'));
    assert.ok(auditCalls.some((c) => c.params[2] === 'is_closed' && c.params[4] === 'true'));
  });

  it('refuses to close a team with non-closed requests and does NOT update it (R20.2)', async () => {
    const { db, runTransaction, calls } = fakeDb((text) => {
      if (text.includes('FOR UPDATE')) {
        return [dbTeam({ id: 1, is_closed: false })];
      }
      if (text.includes('COUNT(*)')) {
        return [{ open_count: 4 }];
      }
      if (text.includes('UPDATE team')) {
        return [dbTeam({ id: 1, is_closed: true })];
      }
      return [];
    });
    const store = new DbTeamAdminStore(new AuditWriter(db), runTransaction);

    await assert.rejects(
      () => store.update(1, { isClosed: true }, 500),
      (e) =>
        e instanceof OpenRequestsConflictError &&
        e.teamId === 1 &&
        e.openRequestCount === 4,
    );

    // Guard blocked the mutation: no UPDATE and no audit row were written.
    assert.equal(callWith(calls, 'UPDATE team'), undefined);
    assert.equal(
      calls.filter((c) => c.text.includes('INSERT INTO audit_entry')).length,
      0,
    );
  });

  it('does not re-check open requests when the team is already closed', async () => {
    const { db, runTransaction, calls } = fakeDb((text) => {
      if (text.includes('FOR UPDATE')) {
        return [dbTeam({ id: 1, is_closed: true })];
      }
      if (text.includes('UPDATE team')) {
        return [dbTeam({ id: 1, is_closed: true, team_leader_id: 300 })];
      }
      return [];
    });
    const store = new DbTeamAdminStore(new AuditWriter(db), runTransaction);

    // Re-closing / editing an already-closed team: the open-request guard is a
    // transition-into-closed check, so it must not run here.
    await store.update(1, { isClosed: true, teamLeaderId: 300 }, 500);
    assert.equal(callWith(calls, 'COUNT(*)'), undefined);
  });
});
