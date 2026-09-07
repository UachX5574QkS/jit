import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Queryable } from '../db/query.js';
import { AuditWriter } from '../audit/index.js';
import {
  DbTaskLeaderStore,
  RetiredDataPointError,
  TaskNotFoundError,
  type TaskFieldInput,
  type TransactionRunner,
} from './task-leader.store.js';

/**
 * Tests for the Postgres-backed task-leader store (design: "Administration",
 * R16, R20.4, R17). A fake {@link Queryable} answers the store's SELECT/INSERT/
 * UPDATE statements and records every call, and the transaction runner is a
 * pass-through that hands that fake queryable to the store — so the create/
 * new-version/retire flows, the data-point usability guard SQL (R16.2), the
 * version-pinning INSERTs (R16.4) and the column-level audit writes (R17) are
 * exercised end to end WITHOUT a live database, matching the sibling store
 * tests. The fake keys responses off a fragment of each SQL statement so the
 * tests assert behaviour (which statements ran, with which bound params) rather
 * than pinning to whitespace.
 */

interface RecordedCall {
  readonly text: string;
  readonly params: readonly unknown[];
}

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

function callWith(calls: RecordedCall[], fragment: string): RecordedCall | undefined {
  return calls.find((c) => c.text.includes(fragment));
}

function callsWith(calls: RecordedCall[], fragment: string): RecordedCall[] {
  return calls.filter((c) => c.text.includes(fragment));
}

/** A minimal non-dropdown field input. */
function field(overrides: Partial<TaskFieldInput> = {}): TaskFieldInput {
  return {
    dataPointId: 10,
    fieldOrder: 0,
    isMandatory: false,
    descriptionOverride: null,
    helpTextOverride: null,
    optionsOverride: null,
    ...overrides,
  };
}

describe('DbTaskLeaderStore.create (R16.1, R16.2, R16.5, R17)', () => {
  it('inserts task, version 1, its fields, points current_version_id, and audits', async () => {
    const { db, runTransaction, calls } = fakeDb((text) => {
      if (text.includes('FROM data_point')) return [{ id: 10, is_retired: false }, { id: 11, is_retired: false }];
      if (text.includes('INSERT INTO task ')) return [{ id: 5, team_id: 1, name: 'Onboard', is_retired: false, current_version_id: null }];
      if (text.includes('INSERT INTO task_version')) return [{ id: 50, version_no: 1, support_notes: 'notes' }];
      if (text.includes('INSERT INTO task_field')) {
        return [{ id: 500, data_point_id: 10, field_order: 0, is_mandatory: true, help_text_override: null, description_override: 'desc', options_override: null }];
      }
      if (text.includes('UPDATE task SET current_version_id')) return [{ id: 5 }];
      return [];
    });
    const store = new DbTaskLeaderStore(new AuditWriter(db), runTransaction);

    const result = await store.create(
      {
        teamId: 1,
        name: 'Onboard',
        supportNotes: 'notes',
        fields: [field({ dataPointId: 10, fieldOrder: 0, isMandatory: true, descriptionOverride: 'desc' })],
      },
      500,
    );

    assert.equal(result.id, 5);
    assert.equal(result.teamId, 1);
    assert.equal(result.currentVersion.versionNo, 1);
    assert.equal(result.currentVersion.fields.length, 1);

    // Version 1 was inserted with bound params (task id, version 1, notes).
    const versionInsert = callWith(calls, 'INSERT INTO task_version');
    assert.ok(versionInsert);
    assert.deepEqual(versionInsert.params, [5, 1, 'notes']);

    // The field insert references the new version id, not any interpolated text.
    const fieldInsert = callWith(calls, 'INSERT INTO task_field');
    assert.ok(fieldInsert);
    assert.equal(fieldInsert.params[0], 50); // task_version_id
    assert.equal(fieldInsert.params[1], 10); // data_point_id

    // current_version_id points at version 1 (R16.5).
    const repoint = callWith(calls, 'UPDATE task SET current_version_id');
    assert.ok(repoint);
    assert.deepEqual(repoint.params, [5, 50]);

    // Task creation is audited column-by-column (null → value).
    const audits = callsWith(calls, 'INSERT INTO audit_entry').filter((c) => c.params[0] === 'task');
    const nameAudit = audits.find((c) => c.params[2] === 'name');
    assert.ok(nameAudit);
    assert.equal(nameAudit.params[4], 'Onboard');
  });

  it('rejects a field referencing a retired data point (R16.2)', async () => {
    const { db, runTransaction, calls } = fakeDb((text) => {
      if (text.includes('FROM data_point')) return [{ id: 10, is_retired: true }];
      return [];
    });
    const store = new DbTaskLeaderStore(new AuditWriter(db), runTransaction);

    await assert.rejects(
      () => store.create({ teamId: 1, name: 'X', supportNotes: null, fields: [field({ dataPointId: 10 })] }, 500),
      (e) => e instanceof RetiredDataPointError && e.dataPointId === 10 && e.reason === 'retired',
    );
    // Guard blocked the mutation: no task/version rows written.
    assert.equal(callWith(calls, 'INSERT INTO task '), undefined);
    assert.equal(callWith(calls, 'INSERT INTO task_version'), undefined);
  });

  it('rejects a field referencing an unknown data point (R16.2)', async () => {
    const { db, runTransaction } = fakeDb((text) => {
      if (text.includes('FROM data_point')) return []; // id not found
      return [];
    });
    const store = new DbTaskLeaderStore(new AuditWriter(db), runTransaction);
    await assert.rejects(
      () => store.create({ teamId: 1, name: 'X', supportNotes: null, fields: [field({ dataPointId: 99 })] }, 500),
      (e) => e instanceof RetiredDataPointError && e.dataPointId === 99 && e.reason === 'unknown',
    );
  });
});

describe('DbTaskLeaderStore.createVersion — version pinning (R16.4, R16.5, R17)', () => {
  it('inserts a NEW version (max+1) with a fresh field set and re-points current_version_id', async () => {
    const { db, runTransaction, calls } = fakeDb((text) => {
      if (text.includes('FROM task') && text.includes('FOR UPDATE')) {
        return [{ id: 5, team_id: 1, name: 'Onboard', is_retired: false, current_version_id: 50 }];
      }
      if (text.includes('FROM data_point')) return [{ id: 10, is_retired: false }];
      if (text.includes('MAX(version_no)')) return [{ max_no: 2 }];
      if (text.includes('INSERT INTO task_version')) return [{ id: 60, version_no: 3, support_notes: 'v3' }];
      if (text.includes('INSERT INTO task_field')) {
        return [{ id: 600, data_point_id: 10, field_order: 0, is_mandatory: false, help_text_override: null, description_override: null, options_override: null }];
      }
      if (text.includes('UPDATE task')) return [{ id: 5 }];
      return [];
    });
    const store = new DbTaskLeaderStore(new AuditWriter(db), runTransaction);

    const result = await store.createVersion(5, { supportNotes: 'v3', fields: [field()] }, 500);

    assert.equal(result.currentVersion.versionNo, 3);

    // New version_no is max(2)+1 = 3, bound as a parameter.
    const versionInsert = callWith(calls, 'INSERT INTO task_version');
    assert.ok(versionInsert);
    assert.deepEqual(versionInsert.params, [5, 3, 'v3']);

    // Version pinning: the store NEVER issues UPDATE/DELETE against existing
    // task_version or task_field rows — prior versions are immutable (R16.4).
    assert.equal(callWith(calls, 'UPDATE task_version'), undefined);
    assert.equal(callWith(calls, 'UPDATE task_field'), undefined);
    assert.equal(callWith(calls, 'DELETE FROM task_version'), undefined);
    assert.equal(callWith(calls, 'DELETE FROM task_field'), undefined);

    // current_version_id re-pointed to the NEW version (R16.5), audited.
    const repoint = callWith(calls, 'UPDATE task');
    assert.ok(repoint);
    assert.equal(repoint.params[2], 60); // new current_version_id
    const audit = callsWith(calls, 'INSERT INTO audit_entry').find((c) => c.params[2] === 'current_version_id');
    assert.ok(audit);
    assert.equal(audit.params[3], '50'); // old
    assert.equal(audit.params[4], '60'); // new
  });

  it('renames the task and audits the name change alongside the version re-point', async () => {
    const { db, runTransaction, calls } = fakeDb((text) => {
      if (text.includes('FROM task') && text.includes('FOR UPDATE')) {
        return [{ id: 5, team_id: 1, name: 'Old', is_retired: false, current_version_id: 50 }];
      }
      if (text.includes('MAX(version_no)')) return [{ max_no: 1 }];
      if (text.includes('INSERT INTO task_version')) return [{ id: 60, version_no: 2, support_notes: null }];
      if (text.includes('UPDATE task')) return [{ id: 5 }];
      return [];
    });
    const store = new DbTaskLeaderStore(new AuditWriter(db), runTransaction);

    const result = await store.createVersion(5, { name: 'New', supportNotes: null, fields: [] }, 500);
    assert.equal(result.name, 'New');

    const nameAudit = callsWith(calls, 'INSERT INTO audit_entry').find((c) => c.params[2] === 'name');
    assert.ok(nameAudit);
    assert.equal(nameAudit.params[3], 'Old');
    assert.equal(nameAudit.params[4], 'New');
  });

  it('throws TaskNotFoundError for an unknown task and writes nothing (R16.4)', async () => {
    const { db, runTransaction, calls } = fakeDb(() => []);
    const store = new DbTaskLeaderStore(new AuditWriter(db), runTransaction);
    await assert.rejects(
      () => store.createVersion(999, { supportNotes: null, fields: [] }, 500),
      (e) => e instanceof TaskNotFoundError,
    );
    assert.equal(callWith(calls, 'INSERT INTO task_version'), undefined);
  });
});

describe('DbTaskLeaderStore.retire (R16.6 / R20.4, R17)', () => {
  it('flips is_retired, audits the change, and keeps the task/version intact', async () => {
    const { db, runTransaction, calls } = fakeDb((text) => {
      if (text.includes('FROM task') && text.includes('FOR UPDATE')) {
        return [{ id: 5, team_id: 1, name: 'Onboard', is_retired: false, current_version_id: 50 }];
      }
      if (text.includes('UPDATE task SET is_retired')) return [{ id: 5 }];
      if (text.includes('FROM task_version')) return [{ id: 50, version_no: 1, support_notes: null }];
      if (text.includes('FROM task_field')) return [];
      return [];
    });
    const store = new DbTaskLeaderStore(new AuditWriter(db), runTransaction);

    const result = await store.retire(5, 500);
    assert.equal(result.isRetired, true);

    // Retirement is a flag flip — the task row is never deleted (R20.4).
    assert.equal(callWith(calls, 'DELETE FROM task'), undefined);
    const audit = callsWith(calls, 'INSERT INTO audit_entry').find((c) => c.params[2] === 'is_retired');
    assert.ok(audit);
    assert.equal(audit.params[3], 'false');
    assert.equal(audit.params[4], 'true');
  });

  it('is idempotent: retiring an already-retired task does not re-update or re-audit', async () => {
    const { db, runTransaction, calls } = fakeDb((text) => {
      if (text.includes('FROM task') && text.includes('FOR UPDATE')) {
        return [{ id: 5, team_id: 1, name: 'Onboard', is_retired: true, current_version_id: 50 }];
      }
      if (text.includes('FROM task_version')) return [{ id: 50, version_no: 1, support_notes: null }];
      if (text.includes('FROM task_field')) return [];
      return [];
    });
    const store = new DbTaskLeaderStore(new AuditWriter(db), runTransaction);

    const result = await store.retire(5, 500);
    assert.equal(result.isRetired, true);
    assert.equal(callWith(calls, 'UPDATE task SET is_retired'), undefined);
    assert.equal(callsWith(calls, 'INSERT INTO audit_entry').length, 0);
  });

  it('throws TaskNotFoundError for an unknown task', async () => {
    const { db, runTransaction } = fakeDb(() => []);
    const store = new DbTaskLeaderStore(new AuditWriter(db), runTransaction);
    await assert.rejects(
      () => store.retire(999, 500),
      (e) => e instanceof TaskNotFoundError,
    );
  });
});

describe('DbTaskLeaderStore.findTeamIdForTask (R16.1 authz support)', () => {
  it('returns the owning team id, or null for an unknown task', async () => {
    const present = fakeDb((text) => (text.includes('SELECT team_id FROM task') ? [{ team_id: 7 }] : []));
    const store = new DbTaskLeaderStore(new AuditWriter(present.db), present.runTransaction);
    assert.equal(await store.findTeamIdForTask(5), 7);

    const absent = fakeDb(() => []);
    const store2 = new DbTaskLeaderStore(new AuditWriter(absent.db), absent.runTransaction);
    assert.equal(await store2.findTeamIdForTask(999), null);
  });
});
