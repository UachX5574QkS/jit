import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Queryable } from '../db/query.js';
import { ApiError } from '../middleware/errors.js';
import {
  DbRequestUserMutationsStore,
  RequestForbiddenError,
  RequestNotFoundError,
  UnknownFieldError,
  type MutationActor,
  type TransactionRunner,
} from './requests-user-mutations.store.js';

/**
 * Tests for the Postgres-backed user-side mutations store (design: "Requests
 * (user side)" — R5.3–5.8). A fake {@link Queryable} answers the store's
 * SELECT/INSERT/UPDATE statements by matching SQL fragments and records every
 * call; the transaction runner is a pass-through that hands that fake to the
 * store — so the raiser gate, field re-validation, audit writes, status
 * transitions, reopen-canceller gate and the non-persisting clone are exercised
 * WITHOUT a live database, matching the request-detail store test style.
 */

interface RecordedCall {
  readonly text: string;
  readonly params: readonly unknown[];
}

/** The request header row the store's header query expects. */
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

/** A merged pinned-version field row (task_field JOIN data_point). */
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

/** A store wired to a fake db. */
function makeStore(responder: (text: string, params: readonly unknown[]) => unknown[]) {
  const fake = fakeDb(responder);
  // The AuditWriter uses the default pool by default, but every recordChanges
  // call passes the transaction `tx` (the fake db) — so no real pool is touched.
  const store = new DbRequestUserMutationsStore(undefined, fake.runTransaction);
  return { store, ...fake };
}

function callWith(calls: RecordedCall[], fragment: string): RecordedCall | undefined {
  return calls.find((c) => c.text.includes(fragment));
}

function callsWith(calls: RecordedCall[], fragment: string): RecordedCall[] {
  return calls.filter((c) => c.text.includes(fragment));
}

/** The raiser (id 100). */
const raiser: MutationActor = { userId: 100, teamsMemberOf: [] };
/** A non-raiser (id 200), not a member of the request's team. */
const stranger: MutationActor = { userId: 200, teamsMemberOf: [] };

// ── updateUserFields (R5.4) ─────────────────────────────────────────────────────

describe('DbRequestUserMutationsStore.updateUserFields (R5.4)', () => {
  it('happy path: updates a changed field value + Jira, audits both, bumps updated_at', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ jira_number: null })];
      if (text.includes('FROM task_field tf')) {
        return [fieldRow({ task_field_id: 1, is_mandatory: true, dp_name: 'Summary' })];
      }
      if (text.includes('FROM request_field_value')) {
        return [{ task_field_id: 1, value: 'old' }];
      }
      if (text.includes('INSERT INTO request_field_value')) return [{ id: 1 }];
      if (text.includes('UPDATE request')) return [{ id: 555 }];
      if (text.includes('INSERT INTO audit_entry')) return [];
      return [];
    });

    const summary = await store.updateUserFields(
      555,
      { jiraNumber: 'JIRA-9', fieldValues: [{ taskFieldId: 1, value: 'new summary' }] },
      raiser,
    );

    assert.equal(summary.id, 555);
    // Field value upserted with the new value.
    const upsert = callWith(calls, 'INSERT INTO request_field_value');
    assert.ok(upsert);
    assert.deepEqual(upsert.params, [555, 1, 'new summary']);
    assert.ok(upsert.text.includes('ON CONFLICT'));
    // Jira updated on the request row.
    const jiraUpdate = callsWith(calls, 'UPDATE request').find((c) =>
      c.text.includes('jira_number'),
    );
    assert.ok(jiraUpdate);
    assert.deepEqual(jiraUpdate.params, [555, 'JIRA-9']);
    // Two audit writes: the field value and the jira column.
    const auditWrites = callsWith(calls, 'INSERT INTO audit_entry');
    assert.ok(auditWrites.some((c) => c.params.includes('field_1')));
    assert.ok(auditWrites.some((c) => c.params.includes('jira_number')));
    // updated_at bumped.
    assert.ok(callsWith(calls, 'UPDATE request').some((c) => c.text.includes('updated_at = now()')));
  });

  it('rejects blanking a MANDATORY field with MANDATORY_FIELD and writes nothing', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow()];
      if (text.includes('FROM task_field tf')) {
        return [fieldRow({ task_field_id: 1, is_mandatory: true })];
      }
      if (text.includes('FROM request_field_value')) return [{ task_field_id: 1, value: 'was here' }];
      return [];
    });

    await assert.rejects(
      () => store.updateUserFields(555, { fieldValues: [{ taskFieldId: 1, value: '' }] }, raiser),
      (e) => e instanceof ApiError && e.code === 'MANDATORY_FIELD',
    );
    // No writes happened before the validation failure.
    assert.equal(callWith(calls, 'INSERT INTO request_field_value'), undefined);
    assert.equal(callWith(calls, 'INSERT INTO audit_entry'), undefined);
  });

  it('rejects a type-invalid value with VALIDATION_FAILED', async () => {
    const { store } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow()];
      if (text.includes('FROM task_field tf')) {
        return [fieldRow({ task_field_id: 1, dp_data_type: 'NUMERIC', dp_name: 'Count' })];
      }
      if (text.includes('FROM request_field_value')) return [];
      return [];
    });

    await assert.rejects(
      () =>
        store.updateUserFields(555, { fieldValues: [{ taskFieldId: 1, value: 'not-a-number' }] }, raiser),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });

  it('rejects a non-raiser with RequestForbiddenError', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ raised_by_id: 100 })];
      return [];
    });

    await assert.rejects(
      () => store.updateUserFields(555, { fieldValues: [{ taskFieldId: 1, value: 'x' }] }, stranger),
      (e) => e instanceof RequestForbiddenError && e.requestId === 555,
    );
    // Bailed out before loading fields.
    assert.equal(callWith(calls, 'FROM task_field tf'), undefined);
  });

  it('rejects a field outside the pinned version with UnknownFieldError', async () => {
    const { store } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow()];
      if (text.includes('FROM task_field tf')) return [fieldRow({ task_field_id: 1 })];
      if (text.includes('FROM request_field_value')) return [];
      return [];
    });

    await assert.rejects(
      () => store.updateUserFields(555, { fieldValues: [{ taskFieldId: 999, value: 'x' }] }, raiser),
      (e) => e instanceof UnknownFieldError && e.taskFieldId === 999,
    );
  });

  it('does not write or audit a field whose value is unchanged', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow()];
      if (text.includes('FROM task_field tf')) return [fieldRow({ task_field_id: 1 })];
      if (text.includes('FROM request_field_value')) return [{ task_field_id: 1, value: 'same' }];
      if (text.includes('UPDATE request')) return [{ id: 555 }];
      return [];
    });

    await store.updateUserFields(555, { fieldValues: [{ taskFieldId: 1, value: 'same' }] }, raiser);
    assert.equal(callWith(calls, 'INSERT INTO request_field_value'), undefined);
    assert.equal(callWith(calls, 'INSERT INTO audit_entry'), undefined);
  });

  it('throws RequestNotFoundError for an unknown request', async () => {
    const { store } = makeStore(() => []);
    await assert.rejects(
      () => store.updateUserFields(999, { fieldValues: [{ taskFieldId: 1, value: 'x' }] }, raiser),
      (e) => e instanceof RequestNotFoundError && e.requestId === 999,
    );
  });
});

// ── cancel (R5.5) ─────────────────────────────────────────────────────────────

describe('DbRequestUserMutationsStore.cancel (R5.5)', () => {
  it('cancels from a NON-stop state → CANCELLED, records who cancelled in the audit', async () => {
    const statuses = ['NEW', 'CANCELLED']; // header re-read after the update
    let headerReads = 0;
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) {
        const status = statuses[Math.min(headerReads, statuses.length - 1)];
        headerReads += 1;
        return [headerRow({ status })];
      }
      if (text.includes('UPDATE request')) return [{ id: 555 }];
      if (text.includes('INSERT INTO audit_entry')) return [];
      return [];
    });

    const summary = await store.cancel(555, raiser);
    assert.equal(summary.status, 'CANCELLED');
    // Status update carried CANCELLED.
    const update = callsWith(calls, 'UPDATE request').find((c) => c.text.includes('status = $2'));
    assert.ok(update);
    assert.deepEqual(update.params, [555, 'CANCELLED']);
    // Audit records the actor as the canceller.
    const audit = callWith(calls, 'INSERT INTO audit_entry');
    assert.ok(audit);
    assert.ok(audit.params.includes('status'));
    assert.ok(audit.params.includes(100)); // changed_by_id = raiser
  });

  it('is blocked from a STOP state with INVALID_TRANSITION', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ status: 'COMPLETE' })];
      return [];
    });
    await assert.rejects(
      () => store.cancel(555, raiser),
      (e) => e instanceof ApiError && e.code === 'INVALID_TRANSITION',
    );
    // No status update was attempted.
    assert.equal(
      callsWith(calls, 'UPDATE request').find((c) => c.text.includes('status = $2')),
      undefined,
    );
  });

  it('rejects a non-raiser with RequestForbiddenError', async () => {
    const { store } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ raised_by_id: 100, status: 'NEW' })];
      return [];
    });
    await assert.rejects(
      () => store.cancel(555, stranger),
      (e) => e instanceof RequestForbiddenError,
    );
  });
});

// ── reopen (R5.6) ─────────────────────────────────────────────────────────────

describe('DbRequestUserMutationsStore.reopen (R5.6)', () => {
  it('the raiser who cancelled it reopens CANCELLED → NEW', async () => {
    const statuses = ['CANCELLED', 'NEW'];
    let headerReads = 0;
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) {
        const status = statuses[Math.min(headerReads, statuses.length - 1)];
        headerReads += 1;
        return [headerRow({ status })];
      }
      if (text.includes('FROM audit_entry')) return [{ changed_by_id: 100 }];
      if (text.includes('UPDATE request')) return [{ id: 555 }];
      if (text.includes('INSERT INTO audit_entry')) return [];
      return [];
    });

    const summary = await store.reopen(555, raiser);
    assert.equal(summary.status, 'NEW');
    const update = callsWith(calls, 'UPDATE request').find((c) => c.text.includes('status = $2'));
    assert.ok(update);
    assert.deepEqual(update.params, [555, 'NEW']);
    // The canceller was looked up from the audit trail.
    const lookup = callWith(calls, 'FROM audit_entry');
    assert.ok(lookup);
    assert.ok(lookup.text.includes("new_value = 'CANCELLED'"));
  });

  it('is FORBIDDEN when a DIFFERENT user cancelled it', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ status: 'CANCELLED' })];
      if (text.includes('FROM audit_entry')) return [{ changed_by_id: 999 }]; // someone else
      return [];
    });
    await assert.rejects(
      () => store.reopen(555, raiser),
      (e) => e instanceof RequestForbiddenError,
    );
    // No status update happened.
    assert.equal(
      callsWith(calls, 'UPDATE request').find((c) => c.text.includes('status = $2')),
      undefined,
    );
  });

  it('is INVALID_TRANSITION from a non-CANCELLED state', async () => {
    const { store } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ status: 'NEW' })];
      return [];
    });
    await assert.rejects(
      () => store.reopen(555, raiser),
      (e) => e instanceof ApiError && e.code === 'INVALID_TRANSITION',
    );
  });

  it('rejects a non-raiser with RequestForbiddenError before any audit lookup', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ raised_by_id: 100, status: 'CANCELLED' })];
      return [];
    });
    await assert.rejects(
      () => store.reopen(555, stranger),
      (e) => e instanceof RequestForbiddenError,
    );
    assert.equal(callWith(calls, 'FROM audit_entry'), undefined);
  });
});

// ── cloneDraft (R5.8) ───────────────────────────────────────────────────────────

describe('DbRequestUserMutationsStore.cloneDraft (R5.8)', () => {
  it('returns a NEW draft echoing task/version fields + values WITHOUT persisting', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ title: 'Toner low', jira_number: 'J-1' })];
      if (text.includes('FROM task_field tf')) {
        return [
          fieldRow({ task_field_id: 1, field_order: 1, dp_name: 'Summary' }),
          fieldRow({
            task_field_id: 2,
            field_order: 2,
            dp_name: 'Priority',
            dp_data_type: 'DROPDOWN',
            dp_default_options: ['Low', 'High'],
          }),
        ];
      }
      if (text.includes('FROM request_field_value')) {
        return [
          { task_field_id: 1, value: 'Toner low' },
          { task_field_id: 2, value: 'High' },
        ];
      }
      return [];
    });

    const draft = await store.cloneDraft(555, raiser);

    assert.equal(draft.status, 'NEW');
    assert.equal(draft.taskId, 42);
    assert.equal(draft.taskName, 'Broken printer');
    assert.equal(draft.teamId, 7);
    assert.equal(draft.sourceTaskVersionId, 900);
    assert.equal(draft.sourceVersionNo, 3);
    assert.equal(draft.title, 'Toner low');
    assert.equal(draft.jiraNumber, 'J-1');
    // Fields echoed in order with their values.
    assert.equal(draft.fields.length, 2);
    assert.equal(draft.fields[0].value, 'Toner low');
    assert.deepEqual(draft.fields[1].options, ['Low', 'High']);
    assert.equal(draft.fields[1].value, 'High');
    // NOTHING was persisted: no request/field-value/note inserts, no updates.
    assert.equal(callWith(calls, 'INSERT INTO request'), undefined);
    assert.equal(callWith(calls, 'INSERT INTO request_note'), undefined);
    assert.equal(callsWith(calls, 'UPDATE request').length, 0);
    assert.equal(callWith(calls, 'INSERT INTO audit_entry'), undefined);
  });

  it('a support member of the request team may clone', async () => {
    const supportMember: MutationActor = { userId: 200, teamsMemberOf: [7] };
    const { store } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ raised_by_id: 100, team_id: 7 })];
      if (text.includes('FROM task_field tf')) return [];
      if (text.includes('FROM request_field_value')) return [];
      return [];
    });
    const draft = await store.cloneDraft(555, supportMember);
    assert.equal(draft.status, 'NEW');
  });

  it('an unrelated viewer is denied with RequestForbiddenError', async () => {
    const { store } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ raised_by_id: 100, team_id: 7 })];
      if (text.includes('WITH RECURSIVE chain')) return [{ visible: false }];
      return [];
    });
    await assert.rejects(
      () => store.cloneDraft(555, { userId: 300, teamsMemberOf: [] }),
      (e) => e instanceof RequestForbiddenError,
    );
  });

  it('a manager in the raiser hierarchy may clone (visibility CTE true)', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ raised_by_id: 100, team_id: 7 })];
      if (text.includes('WITH RECURSIVE chain')) return [{ visible: true }];
      if (text.includes('FROM task_field tf')) return [];
      if (text.includes('FROM request_field_value')) return [];
      return [];
    });
    const draft = await store.cloneDraft(555, { userId: 300, teamsMemberOf: [] });
    assert.equal(draft.status, 'NEW');
    const vis = callWith(calls, 'WITH RECURSIVE chain');
    assert.ok(vis);
    assert.equal(vis.params[0], 100); // raiser
    assert.equal(vis.params[1], 300); // viewer
  });

  it('throws RequestNotFoundError for an unknown request', async () => {
    const { store } = makeStore(() => []);
    await assert.rejects(
      () => store.cloneDraft(999, raiser),
      (e) => e instanceof RequestNotFoundError && e.requestId === 999,
    );
  });
});
