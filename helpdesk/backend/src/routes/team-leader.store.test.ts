import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Queryable } from '../db/query.js';
import { AuditWriter } from '../audit/index.js';
import {
  DbTeamLeaderStore,
  MemberRemovalConflictError,
  TeamNotFoundError,
  type TransactionRunner,
} from './team-leader.store.js';

/**
 * Tests for the Postgres-backed team-leader store (design: "Administration",
 * R15, R20.3, R17). A fake {@link Queryable} answers the store's SELECT/UPDATE/
 * INSERT/DELETE/COUNT statements and records every call, and the transaction
 * runner is a pass-through that hands that fake queryable to the store — so the
 * detail update, the membership add/remove, the member-removal guard SQL
 * (R15.4 / R20.3), and the column-level audit writes (R17) are exercised end to
 * end WITHOUT a live database, matching the team-admin store test style.
 *
 * The fake keys its responses off a fragment of each SQL statement rather than
 * the exact text, so the tests assert behaviour (which statements ran, with
 * which bound params) rather than pinning to whitespace.
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
    description: 'Handles money',
    team_leader_id: 100,
    is_closed: false,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

/** A snake_case member row as the join would return it. */
function dbMember(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    user_id: 200,
    username: '00000200',
    first_name: 'Ada',
    surname: 'Lovelace',
    ...overrides,
  };
}

/**
 * A fake queryable + a pass-through transaction runner. `responder` returns the
 * rows for a given statement; `calls` records everything for assertions.
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

/** Find all recorded calls whose SQL contains `fragment`. */
function callsWith(calls: RecordedCall[], fragment: string): RecordedCall[] {
  return calls.filter((c) => c.text.includes(fragment));
}

describe('DbTeamLeaderStore.getWithMembers (R15.2, R15.3)', () => {
  it('returns team details and membership with bound team id', async () => {
    const { db, calls } = fakeDb((text) => {
      // NOTE: check team_member before team — 'FROM team' is a substring of
      // 'FROM team_member', so the member join must be matched first.
      if (text.includes('FROM team_member')) {
        return [dbMember({ user_id: 200 }), dbMember({ user_id: 201, first_name: 'Grace', surname: 'Hopper' })];
      }
      if (text.includes('FROM team')) {
        return [dbTeam({ id: 7, title: 'Access' })];
      }
      return [];
    });
    const store = new DbTeamLeaderStore(new AuditWriter(db), (fn) => fn(db), db);

    const result = await store.getWithMembers(7);

    assert.equal(result.team.id, 7);
    assert.equal(result.team.title, 'Access');
    assert.equal(result.members.length, 2);
    assert.deepEqual(
      result.members.map((m) => m.displayName),
      ['Ada Lovelace', 'Grace Hopper'],
    );
    const teamRead = callWith(calls, 'FROM team');
    assert.ok(teamRead);
    assert.deepEqual(teamRead.params, [7]);
  });

  it('throws TeamNotFoundError for an unknown id', async () => {
    const { db } = fakeDb(() => []);
    const store = new DbTeamLeaderStore(new AuditWriter(db), (fn) => fn(db), db);
    await assert.rejects(
      () => store.getWithMembers(999),
      (e) => e instanceof TeamNotFoundError,
    );
  });
});

describe('DbTeamLeaderStore.update — detail changes (R15.2, R17)', () => {
  it('updates title/description and audits only the changed columns', async () => {
    const { db, runTransaction, calls } = fakeDb((text) => {
      if (text.includes('FOR UPDATE')) {
        return [dbTeam({ id: 1, title: 'Payments', description: 'Handles money' })];
      }
      if (text.includes('UPDATE team')) {
        return [dbTeam({ id: 1, title: 'Payments Team', description: 'Handles money' })];
      }
      if (text.includes('FROM team_member')) {
        return [];
      }
      if (text.includes('FROM team')) {
        return [dbTeam({ id: 1, title: 'Payments Team', description: 'Handles money' })];
      }
      return [];
    });
    const store = new DbTeamLeaderStore(new AuditWriter(db), runTransaction);

    const result = await store.update(1, { title: 'Payments Team' }, 500);
    assert.equal(result.team.title, 'Payments Team');

    const update = callWith(calls, 'UPDATE team');
    assert.ok(update);
    assert.deepEqual(update.params, [1, 'Payments Team', 'Handles money']);

    // Only the title changed → exactly one audit row.
    const auditCalls = callsWith(calls, 'INSERT INTO audit_entry');
    assert.equal(auditCalls.length, 1);
    assert.equal(auditCalls[0].params[0], 'team');
    assert.equal(auditCalls[0].params[2], 'title');
    assert.equal(auditCalls[0].params[3], 'Payments');
    assert.equal(auditCalls[0].params[4], 'Payments Team');
    assert.equal(auditCalls[0].params[5], 500);
  });

  it('does not UPDATE the team row when no detail fields are supplied', async () => {
    const { db, runTransaction, calls } = fakeDb((text) => {
      if (text.includes('FOR UPDATE')) return [dbTeam({ id: 1 })];
      if (text.includes('team_member')) return [];
      if (text.includes('FROM team')) return [dbTeam({ id: 1 })];
      return [];
    });
    const store = new DbTeamLeaderStore(new AuditWriter(db), runTransaction);

    await store.update(1, { addMemberIds: [] }, 500);
    // No detail change → no UPDATE team, no audit row for team details.
    assert.equal(callWith(calls, 'UPDATE team'), undefined);
  });

  it('throws TeamNotFoundError for an unknown id (no update runs)', async () => {
    const { db, runTransaction, calls } = fakeDb(() => []);
    const store = new DbTeamLeaderStore(new AuditWriter(db), runTransaction);
    await assert.rejects(
      () => store.update(999, { title: 'X' }, 500),
      (e) => e instanceof TeamNotFoundError,
    );
    assert.equal(callWith(calls, 'UPDATE team'), undefined);
  });
});

describe('DbTeamLeaderStore.update — add members (R15.3, R17)', () => {
  it('inserts new members with bound params and audits each insert', async () => {
    const { db, runTransaction, calls } = fakeDb((text) => {
      if (text.includes('FOR UPDATE')) return [dbTeam({ id: 1 })];
      if (text.includes('INSERT INTO team_member')) return [{ user_id: 200 }];
      if (text.includes('FROM team_member')) return [dbMember({ user_id: 200 })];
      if (text.includes('FROM team')) return [dbTeam({ id: 1 })];
      return [];
    });
    const store = new DbTeamLeaderStore(new AuditWriter(db), runTransaction);

    await store.update(1, { addMemberIds: [200] }, 500);

    const insert = callWith(calls, 'INSERT INTO team_member');
    assert.ok(insert);
    assert.deepEqual(insert.params, [1, 200]);
    assert.ok(insert.text.includes('ON CONFLICT'));

    // The insert is audited at the team_member entity level (null → user id).
    const auditCalls = callsWith(calls, 'INSERT INTO audit_entry');
    const addAudit = auditCalls.find((c) => c.params[0] === 'team_member');
    assert.ok(addAudit);
    assert.equal(addAudit.params[3], null); // old_value
    assert.equal(addAudit.params[4], '200'); // new_value
  });

  it('does not audit a re-add that hit ON CONFLICT DO NOTHING (no returned row)', async () => {
    const { db, runTransaction, calls } = fakeDb((text) => {
      if (text.includes('FOR UPDATE')) return [dbTeam({ id: 1 })];
      if (text.includes('INSERT INTO team_member')) return []; // conflict, nothing inserted
      if (text.includes('FROM team_member')) return [dbMember({ user_id: 200 })];
      if (text.includes('FROM team')) return [dbTeam({ id: 1 })];
      return [];
    });
    const store = new DbTeamLeaderStore(new AuditWriter(db), runTransaction);

    await store.update(1, { addMemberIds: [200] }, 500);
    assert.equal(callsWith(calls, 'INSERT INTO audit_entry').length, 0);
  });
});

describe('DbTeamLeaderStore.update — remove members guarded by open requests (R15.4 / R20.3)', () => {
  it('removes a member with zero non-closed requests and audits the removal', async () => {
    const { db, runTransaction, calls } = fakeDb((text) => {
      if (text.includes('FOR UPDATE')) return [dbTeam({ id: 1 })];
      if (text.includes('COUNT(*)')) return [{ open_count: 0 }];
      if (text.includes('DELETE FROM team_member')) return [{ user_id: 200 }];
      if (text.includes('FROM team_member')) return [];
      if (text.includes('FROM team')) return [dbTeam({ id: 1 })];
      return [];
    });
    const store = new DbTeamLeaderStore(new AuditWriter(db), runTransaction);

    await store.update(1, { removeMemberIds: [200] }, 500);

    // The guard consulted the request table scoped to this team + member and
    // excluded the stop states via a bound array (parameterised).
    const count = callWith(calls, 'COUNT(*)');
    assert.ok(count);
    assert.equal(count.params[0], 1); // team_id
    assert.equal(count.params[1], 200); // assigned_member_id
    assert.deepEqual(count.params[2], ['REJECTED', 'CANCELLED', 'COMPLETE']);

    const del = callWith(calls, 'DELETE FROM team_member');
    assert.ok(del);
    assert.deepEqual(del.params, [1, 200]);

    // The removal is audited (user id → null).
    const removeAudit = callsWith(calls, 'INSERT INTO audit_entry').find(
      (c) => c.params[0] === 'team_member',
    );
    assert.ok(removeAudit);
    assert.equal(removeAudit.params[3], '200'); // old_value
    assert.equal(removeAudit.params[4], null); // new_value
  });

  it('refuses to remove a member with non-closed requests and does NOT delete (R15.4)', async () => {
    const { db, runTransaction, calls } = fakeDb((text) => {
      if (text.includes('FOR UPDATE')) return [dbTeam({ id: 1 })];
      if (text.includes('COUNT(*)')) return [{ open_count: 3 }];
      if (text.includes('DELETE FROM team_member')) return [{ user_id: 200 }];
      return [];
    });
    const store = new DbTeamLeaderStore(new AuditWriter(db), runTransaction);

    await assert.rejects(
      () => store.update(1, { removeMemberIds: [200] }, 500),
      (e) =>
        e instanceof MemberRemovalConflictError &&
        e.teamId === 1 &&
        e.userId === 200 &&
        e.openRequestCount === 3,
    );

    // Guard blocked the mutation: no DELETE and no audit row were written.
    assert.equal(callWith(calls, 'DELETE FROM team_member'), undefined);
    assert.equal(callsWith(calls, 'INSERT INTO audit_entry').length, 0);
  });
});
