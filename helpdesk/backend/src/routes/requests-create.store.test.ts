import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Queryable } from '../db/query.js';
import { AuditWriter } from '../audit/index.js';
import { ApiError } from '../middleware/errors.js';
import {
  DbRequestCreateStore,
  TaskNotFoundError,
  UnknownFieldError,
  type CreateRequestInput,
  type TransactionRunner,
} from './requests-create.store.js';

/**
 * Tests for the Postgres-backed request-create store (design: "Requests (user
 * side)" — `POST /api/requests`, R2.14, R3, R17). A fake {@link Queryable}
 * answers the store's SELECT/INSERT statements and records every call, and the
 * transaction runner is a pass-through that hands that fake to the store — so
 * the version load, server-side field validation (R3), the request +
 * field-value inserts, the column-level audit writes (R17) and the last-seen
 * upsert (R5.2) are exercised end to end WITHOUT a live database, matching the
 * team-admin store test style.
 */

interface RecordedCall {
  readonly text: string;
  readonly params: readonly unknown[];
}

/** The task + current-version header row the store's first query expects. */
function headerRow(overrides: Partial<Record<string, unknown>> = {}) {
  return { task_id: 42, team_id: 7, version_id: 900, ...overrides };
}

/** A merged current-version field row (task_field JOIN data_point). */
function fieldRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    task_field_id: 1,
    is_mandatory: false,
    options_override: null,
    dp_name: 'Summary',
    dp_data_type: 'TEXT',
    dp_default_options: null,
    dp_regexp_pattern: null,
    ...overrides,
  };
}

/** The inserted `request` row the store's INSERT ... RETURNING yields. */
function insertedRequestRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 555,
    task_reference: 'REQ-TEST-000001',
    task_version_id: 900,
    title: 'Broken printer',
    raised_by_id: 100,
    team_id: 7,
    assigned_member_id: null,
    status: 'NEW',
    jira_number: null,
    estimated_start_date: null,
    actual_start_date: null,
    created_at: new Date('2026-02-01T09:00:00.000Z'),
    updated_at: new Date('2026-02-01T09:00:00.000Z'),
    ...overrides,
  };
}

/**
 * A fake queryable + pass-through transaction runner. `responder` returns the
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

/** All recorded calls whose SQL contains `fragment`. */
function callsWith(calls: RecordedCall[], fragment: string): RecordedCall[] {
  return calls.filter((c) => c.text.includes(fragment));
}

/** A store wired to a fake db with a deterministic reference generator. */
function makeStore(
  responder: (text: string, params: readonly unknown[]) => unknown[],
  reference = 'REQ-TEST-000001',
) {
  const fake = fakeDb(responder);
  const store = new DbRequestCreateStore(
    new AuditWriter(fake.db),
    fake.runTransaction,
    () => reference,
  );
  return { store, ...fake };
}

const baseInput: CreateRequestInput = {
  taskId: 42,
  title: 'Broken printer',
  jiraNumber: null,
  estimatedStartDate: null,
  actualStartDate: null,
  fieldValues: [{ taskFieldId: 1, value: 'Toner low' }],
};

describe('DbRequestCreateStore.create — happy path (R2.14, R9.2, R16.4)', () => {
  it('inserts a request with a unique reference, pinned version, and returns NEW + timestamps', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM task t')) return [headerRow()];
      if (text.includes('FROM task_field tf')) return [fieldRow({ task_field_id: 1 })];
      if (text.includes('INSERT INTO request')) return [insertedRequestRow()];
      return [];
    });

    const row = await store.create(baseInput, 100);

    // Unique reference assigned, status NEW, version pinned, timestamps present.
    assert.equal(row.taskReference, 'REQ-TEST-000001');
    assert.equal(row.status, 'NEW');
    assert.equal(row.taskVersionId, 900);
    assert.equal(row.teamId, 7);
    assert.equal(row.raisedById, 100);
    assert.ok(row.createdAt);
    assert.ok(row.updatedAt);

    // The request INSERT bound the reference + pinned version (no interpolation).
    const insert = callWith(calls, 'INSERT INTO request');
    assert.ok(insert);
    assert.equal(insert.params[0], 'REQ-TEST-000001'); // task_reference
    assert.equal(insert.params[1], 900); // task_version_id (pinned)
    assert.equal(insert.params[2], 'Broken printer'); // title
    assert.equal(insert.params[3], 100); // raised_by_id = current user
    assert.equal(insert.params[4], 7); // team_id resolved from the task
  });

  it('persists a request_field_value per entered value with bound params', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM task t')) return [headerRow()];
      if (text.includes('FROM task_field tf')) {
        return [fieldRow({ task_field_id: 1 }), fieldRow({ task_field_id: 2, dp_name: 'Detail' })];
      }
      if (text.includes('INSERT INTO request_field_value')) return [{ id: 1 }];
      if (text.includes('INSERT INTO request')) return [insertedRequestRow()];
      return [];
    });

    await store.create(
      {
        ...baseInput,
        fieldValues: [
          { taskFieldId: 1, value: 'Toner low' },
          { taskFieldId: 2, value: 'Since Monday' },
        ],
      },
      100,
    );

    const values = callsWith(calls, 'INSERT INTO request_field_value');
    assert.equal(values.length, 2);
    assert.equal(values[0].params[0], 555); // request_id
    assert.equal(values[0].params[1], 1); // task_field_id
    assert.equal(values[0].params[2], 'Toner low'); // value
    assert.equal(values[1].params[1], 2);
    assert.equal(values[1].params[2], 'Since Monday');
  });

  it('writes column-level audit rows for the request in the same transaction (R17)', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM task t')) return [headerRow()];
      if (text.includes('FROM task_field tf')) return [fieldRow({ task_field_id: 1 })];
      if (text.includes('INSERT INTO request_field_value')) return [{ id: 1 }];
      if (text.includes('INSERT INTO request')) return [insertedRequestRow()];
      return [];
    });

    await store.create(baseInput, 100);

    const audits = callsWith(calls, 'INSERT INTO audit_entry');
    assert.ok(audits.length >= 1, 'at least one audit row written');

    // The request-entity audit rows carry entity_type=request, entity_id=555,
    // and the acting raiser id (100) as changed_by (R17.1).
    const requestAudits = audits.filter((c) => c.params[0] === 'request');
    assert.ok(requestAudits.length >= 1);
    for (const a of requestAudits) {
      assert.equal(a.params[1], 555); // entity_id
      assert.equal(a.params[5], 100); // changed_by_id
    }
    // Status and the pinned version were among the audited first-set columns.
    assert.ok(requestAudits.some((c) => c.params[2] === 'status' && c.params[4] === 'NEW'));
    assert.ok(
      requestAudits.some((c) => c.params[2] === 'task_version_id' && c.params[4] === '900'),
    );

    // The captured field value is also audited (R17.2).
    assert.ok(audits.some((c) => c.params[0] === 'request_field_value'));
  });

  it('records the raiser last-seen so a new request is not "Updated" to them (R5.2)', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM task t')) return [headerRow()];
      if (text.includes('FROM task_field tf')) return [fieldRow({ task_field_id: 1 })];
      if (text.includes('INSERT INTO request_field_value')) return [{ id: 1 }];
      if (text.includes('INSERT INTO request_last_seen')) return [{ id: 1 }];
      if (text.includes('INSERT INTO request')) return [insertedRequestRow()];
      return [];
    });

    await store.create(baseInput, 100);

    const seen = callWith(calls, 'INSERT INTO request_last_seen');
    assert.ok(seen);
    assert.equal(seen.params[0], 555); // request_id
    assert.equal(seen.params[1], 100); // user_id = raiser
  });
});

describe('DbRequestCreateStore.create — validation (R3, R3.6)', () => {
  it('rejects a missing mandatory field with MANDATORY_FIELD and writes nothing', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM task t')) return [headerRow()];
      if (text.includes('FROM task_field tf')) {
        return [fieldRow({ task_field_id: 1, is_mandatory: true, dp_name: 'Summary' })];
      }
      return [];
    });

    await assert.rejects(
      // No value supplied for the mandatory field.
      () => store.create({ ...baseInput, fieldValues: [] }, 100),
      (e) => e instanceof ApiError && e.code === 'MANDATORY_FIELD',
    );

    // No request/field/audit was written — validation ran before any insert.
    assert.equal(callWith(calls, 'INSERT INTO request'), undefined);
    assert.equal(callWith(calls, 'INSERT INTO request_field_value'), undefined);
    assert.equal(callWith(calls, 'INSERT INTO audit_entry'), undefined);
  });

  it('rejects a type-invalid value with VALIDATION_FAILED and writes nothing', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM task t')) return [headerRow()];
      if (text.includes('FROM task_field tf')) {
        return [fieldRow({ task_field_id: 1, dp_name: 'Email', dp_data_type: 'EMAIL' })];
      }
      return [];
    });

    await assert.rejects(
      () =>
        store.create(
          { ...baseInput, fieldValues: [{ taskFieldId: 1, value: 'not-an-email' }] },
          100,
        ),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );

    assert.equal(callWith(calls, 'INSERT INTO request'), undefined);
    assert.equal(callWith(calls, 'INSERT INTO audit_entry'), undefined);
  });

  it('rejects a value for a field outside the pinned version (UnknownFieldError)', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM task t')) return [headerRow()];
      if (text.includes('FROM task_field tf')) return [fieldRow({ task_field_id: 1 })];
      return [];
    });

    await assert.rejects(
      () =>
        store.create(
          { ...baseInput, fieldValues: [{ taskFieldId: 999, value: 'x' }] },
          100,
        ),
      (e) => e instanceof UnknownFieldError && e.taskFieldId === 999,
    );
    assert.equal(callWith(calls, 'INSERT INTO request'), undefined);
  });
});

describe('DbRequestCreateStore.create — unknown task (R2.14)', () => {
  it('throws TaskNotFoundError when the task/current version is absent', async () => {
    const { store, calls } = makeStore(() => []); // header query finds nothing

    await assert.rejects(
      () => store.create(baseInput, 100),
      (e) => e instanceof TaskNotFoundError && e.taskId === 42,
    );
    assert.equal(callWith(calls, 'INSERT INTO request'), undefined);
  });
});
