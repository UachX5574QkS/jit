import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Queryable } from '../db/query.js';
import {
  DbRequestDetailStore,
  RequestForbiddenError,
  RequestNotFoundError,
  type DetailViewer,
  type TransactionRunner,
} from './requests-detail.store.js';

/**
 * Tests for the Postgres-backed request-detail store (design: "Requests (user
 * side)" — `GET /api/requests/{id}`, R5.1, R5.2, R17.4). A fake
 * {@link Queryable} answers the store's SELECT/INSERT statements by matching SQL
 * fragments and records every call, and the transaction runner is a
 * pass-through that hands that fake to the store — so the header load, the
 * field/value merge, the notes read, the audit-trail read, the internal
 * exclusion for non-support viewers and the last-seen upsert are exercised
 * WITHOUT a live database, matching the request-create store test style.
 */

interface RecordedCall {
  readonly text: string;
  readonly params: readonly unknown[];
}

/** The request header row the store's first query expects. */
function headerRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 555,
    task_reference: 'REQ-TEST-000001',
    task_version_id: 900,
    task_id: 42,
    task_name: 'Broken printer',
    version_no: 3,
    title: 'Toner low',
    raised_by_id: 100,
    team_id: 7,
    assigned_member_id: null,
    status: 'NEW',
    jira_number: null,
    estimated_start_date: null,
    actual_start_date: null,
    created_at: new Date('2026-02-01T09:00:00.000Z'),
    updated_at: new Date('2026-02-01T10:00:00.000Z'),
    ...overrides,
  };
}

/** A merged current-version field row (task_field JOIN data_point LEFT JOIN value). */
function fieldRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    task_field_id: 1,
    data_point_id: 11,
    field_order: 1,
    is_mandatory: false,
    description_override: null,
    help_text_override: null,
    options_override: null,
    dp_name: 'Summary',
    dp_data_type: 'TEXT',
    dp_description: null,
    dp_default_help_text: null,
    dp_default_options: null,
    dp_regexp_pattern: null,
    value: 'Toner low',
    ...overrides,
  };
}

/** A request_note row. */
function noteRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    author_id: 100,
    is_internal: false,
    body: 'External note',
    created_at: new Date('2026-02-01T09:30:00.000Z'),
    ...overrides,
  };
}

/** An audit_entry row. */
function auditRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    entity_type: 'request',
    entity_id: 555,
    field_name: 'status',
    old_value: null,
    new_value: 'NEW',
    changed_by_id: 100,
    changed_at: new Date('2026-02-01T09:00:00.000Z'),
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

function callWith(calls: RecordedCall[], fragment: string): RecordedCall | undefined {
  return calls.find((c) => c.text.includes(fragment));
}

/** A store wired to a fake db. */
function makeStore(responder: (text: string, params: readonly unknown[]) => unknown[]) {
  const fake = fakeDb(responder);
  const store = new DbRequestDetailStore(fake.runTransaction);
  return { store, ...fake };
}

/** A support viewer: member of the request's team (7). */
const supportViewer: DetailViewer = { userId: 200, teamsMemberOf: [7] };
/** The raiser (id 100), NOT a support member of any team. */
const raiserViewer: DetailViewer = { userId: 100, teamsMemberOf: [] };

describe('DbRequestDetailStore.getDetail — full assembly (R5.1, R17.4)', () => {
  it('assembles the request header, fields merged with values, notes and audit trail', async () => {
    const { store } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow()];
      if (text.includes('FROM task_field tf')) {
        return [fieldRow({ task_field_id: 1, value: 'Toner low' })];
      }
      if (text.includes('author_id, is_internal, body')) return [noteRow()];
      if (text.includes('entity_type, entity_id, field_name')) return [auditRow()];
      if (text.includes('INSERT INTO request_last_seen')) return [{ id: 1 }];
      return [];
    });

    const detail = await store.getDetail(555, supportViewer);

    assert.equal(detail.id, 555);
    assert.equal(detail.taskReference, 'REQ-TEST-000001');
    assert.equal(detail.taskId, 42);
    assert.equal(detail.taskName, 'Broken printer');
    assert.equal(detail.versionNo, 3);
    assert.equal(detail.teamId, 7);
    assert.equal(detail.status, 'NEW');
    assert.equal(detail.createdAt, '2026-02-01T09:00:00.000Z');
    assert.equal(detail.updatedAt, '2026-02-01T10:00:00.000Z');

    // Field merged with its entered value.
    assert.equal(detail.fields.length, 1);
    assert.equal(detail.fields[0].taskFieldId, 1);
    assert.equal(detail.fields[0].name, 'Summary');
    assert.equal(detail.fields[0].value, 'Toner low');

    // Notes + audit trail present.
    assert.equal(detail.notes.length, 1);
    assert.equal(detail.notes[0].body, 'External note');
    assert.equal(detail.auditTrail.length, 1);
    assert.equal(detail.auditTrail[0].fieldName, 'status');
    assert.equal(detail.auditTrail[0].newValue, 'NEW');
    assert.equal(detail.auditTrail[0].changedAt, '2026-02-01T09:00:00.000Z');
  });

  it('resolves a dropdown field option list and echoes the entered value', async () => {
    const { store } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow()];
      if (text.includes('FROM task_field tf')) {
        return [
          fieldRow({
            task_field_id: 2,
            dp_name: 'Priority',
            dp_data_type: 'DROPDOWN',
            dp_default_options: ['Low', 'High'],
            value: 'High',
          }),
        ];
      }
      if (text.includes('author_id, is_internal, body')) return [];
      if (text.includes('entity_type, entity_id, field_name')) return [];
      if (text.includes('INSERT INTO request_last_seen')) return [{ id: 1 }];
      return [];
    });

    const detail = await store.getDetail(555, supportViewer);
    assert.deepEqual(detail.fields[0].options, ['Low', 'High']);
    assert.equal(detail.fields[0].value, 'High');
  });
});

describe('DbRequestDetailStore.getDetail — internal exclusion (R5.1, R17.4, R7.3)', () => {
  it('SUPPORT viewer: reads notes and audit WITHOUT the is_internal=false filter (sees everything)', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow()];
      if (text.includes('FROM task_field tf')) return [fieldRow()];
      // Support query has NO is_internal filter → return both notes.
      if (text.includes('author_id, is_internal, body')) {
        return [noteRow({ id: 1, is_internal: false }), noteRow({ id: 2, is_internal: true, body: 'Internal note' })];
      }
      if (text.includes('entity_type, entity_id, field_name')) {
        return [auditRow({ id: 1, entity_type: 'request' }), auditRow({ id: 2, entity_type: 'request_note', entity_id: 2, field_name: 'body' })];
      }
      if (text.includes('INSERT INTO request_last_seen')) return [{ id: 1 }];
      return [];
    });

    const detail = await store.getDetail(555, supportViewer);

    // The support notes query must NOT restrict to non-internal notes.
    const notesQuery = callWith(calls, 'author_id, is_internal, body');
    assert.ok(notesQuery);
    assert.equal(notesQuery.text.includes('is_internal = false'), false);
    // The support audit query must NOT restrict the note subquery to non-internal.
    const auditQuery = callWith(calls, 'entity_type, entity_id, field_name');
    assert.ok(auditQuery);
    assert.equal(auditQuery.text.includes('is_internal = false'), false);

    // The internal note and its audit entry are visible to support.
    assert.ok(detail.notes.some((n) => n.isInternal && n.body === 'Internal note'));
    assert.ok(detail.auditTrail.some((a) => a.entityType === 'request_note' && a.entityId === 2));
  });

  it('NON-support viewer (raiser): reads notes and audit WITH the is_internal=false filter', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow()];
      if (text.includes('FROM task_field tf')) return [fieldRow()];
      // Non-support query restricts to non-internal → the DB returns only those.
      if (text.includes('author_id, is_internal, body')) {
        assert.ok(text.includes('is_internal = false'), 'non-support notes query filters internal');
        return [noteRow({ id: 1, is_internal: false })];
      }
      if (text.includes('entity_type, entity_id, field_name')) {
        assert.ok(text.includes('is_internal = false'), 'non-support audit query filters internal-note entries');
        return [auditRow({ id: 1, entity_type: 'request' })];
      }
      if (text.includes('INSERT INTO request_last_seen')) return [{ id: 1 }];
      return [];
    });

    const detail = await store.getDetail(555, raiserViewer);

    // Only the external note and non-internal-note audit entries come back.
    assert.equal(detail.notes.length, 1);
    assert.equal(detail.notes[0].isInternal, false);
    assert.ok(detail.auditTrail.every((a) => a.entityType !== 'request_note' || a.newValue !== 'Internal note'));

    // The non-support notes/audit queries carried the internal filter.
    assert.ok(callWith(calls, 'is_internal = false'));
  });
});

describe('DbRequestDetailStore.getDetail — last_seen upsert (R5.2)', () => {
  it('upserts request_last_seen for the viewing user with bound params', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow()];
      if (text.includes('FROM task_field tf')) return [fieldRow()];
      if (text.includes('author_id, is_internal, body')) return [];
      if (text.includes('entity_type, entity_id, field_name')) return [];
      if (text.includes('INSERT INTO request_last_seen')) return [{ id: 1 }];
      return [];
    });

    await store.getDetail(555, supportViewer);

    const seen = callWith(calls, 'INSERT INTO request_last_seen');
    assert.ok(seen);
    assert.ok(seen.text.includes('ON CONFLICT'));
    assert.equal(seen.params[0], 555); // request_id
    assert.equal(seen.params[1], 200); // user_id = viewer
  });
});

describe('DbRequestDetailStore.getDetail — unknown id (404)', () => {
  it('throws RequestNotFoundError and records no last_seen', async () => {
    const { store, calls } = makeStore(() => []); // header query finds nothing

    await assert.rejects(
      () => store.getDetail(999, supportViewer),
      (e) => e instanceof RequestNotFoundError && e.requestId === 999,
    );
    assert.equal(callWith(calls, 'INSERT INTO request_last_seen'), undefined);
  });
});

describe('DbRequestDetailStore.getDetail — visibility', () => {
  it('the raiser may view even without support membership', async () => {
    const { store } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ raised_by_id: 100 })];
      if (text.includes('FROM task_field tf')) return [];
      if (text.includes('author_id, is_internal, body')) return [];
      if (text.includes('entity_type, entity_id, field_name')) return [];
      if (text.includes('INSERT INTO request_last_seen')) return [{ id: 1 }];
      return [];
    });

    const detail = await store.getDetail(555, raiserViewer);
    assert.equal(detail.raisedById, 100);
  });

  it('a manager in the raiser hierarchy may view (visibility CTE returns true)', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ raised_by_id: 100 })];
      if (text.includes('WITH RECURSIVE chain')) return [{ visible: true }];
      if (text.includes('FROM task_field tf')) return [];
      if (text.includes('author_id, is_internal, body')) return [];
      if (text.includes('entity_type, entity_id, field_name')) return [];
      if (text.includes('INSERT INTO request_last_seen')) return [{ id: 1 }];
      return [];
    });

    // Viewer 300 is neither the raiser nor a support member, but is a manager.
    const detail = await store.getDetail(555, { userId: 300, teamsMemberOf: [] });
    assert.equal(detail.id, 555);
    // The visibility CTE was consulted with (raiserId, viewerId).
    const vis = callWith(calls, 'WITH RECURSIVE chain');
    assert.ok(vis);
    assert.equal(vis.params[0], 100); // raiser
    assert.equal(vis.params[1], 300); // viewer
  });

  it('an unrelated viewer is denied with RequestForbiddenError', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ raised_by_id: 100 })];
      if (text.includes('WITH RECURSIVE chain')) return [{ visible: false }];
      return [];
    });

    await assert.rejects(
      () => store.getDetail(555, { userId: 300, teamsMemberOf: [] }),
      (e) => e instanceof RequestForbiddenError && e.requestId === 555,
    );
    // No last_seen recorded for a denied viewer.
    assert.equal(callWith(calls, 'INSERT INTO request_last_seen'), undefined);
  });
});
