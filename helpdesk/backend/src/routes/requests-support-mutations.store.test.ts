import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Queryable } from '../db/query.js';
import { ApiError } from '../middleware/errors.js';
import {
  AssigneeNotInTeamError,
  DbRequestSupportMutationsStore,
  RequestForbiddenError,
  RequestNotFoundError,
  UnknownFieldError,
  type SupportActor,
  type TransactionRunner,
} from './requests-support-mutations.store.js';

/**
 * Tests for the Postgres-backed support-side mutation store (design: "Support
 * side" — `PATCH /api/requests/{id}`; R7.1, R7.2, R9). A fake {@link Queryable}
 * answers the store's SELECT/INSERT/UPDATE statements by matching SQL fragments
 * and records every call; the transaction runner is a pass-through that hands
 * that fake to the store — so the support-member gate, field re-validation,
 * status state-machine, assignment membership check, and same-transaction audit
 * writes are exercised WITHOUT a live database, matching the user-mutations
 * store test style.
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
    status: 'ASSIGNED',
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
  const store = new DbRequestSupportMutationsStore(undefined, fake.runTransaction);
  return { store, ...fake };
}

function callWith(calls: RecordedCall[], fragment: string): RecordedCall | undefined {
  return calls.find((c) => c.text.includes(fragment));
}

function callsWith(calls: RecordedCall[], fragment: string): RecordedCall[] {
  return calls.filter((c) => c.text.includes(fragment));
}

/** A support member of the request's team (team 7). */
const supporter: SupportActor = { userId: 200, teamsMemberOf: [7] };
/** A user who is NOT a member of the request's team. */
const outsider: SupportActor = { userId: 300, teamsMemberOf: [8, 9] };

// ── Field updates (R7.1) ─────────────────────────────────────────────────────

describe('DbRequestSupportMutationsStore.updateRequest — fields (R7.1)', () => {
  it('happy path: updates a changed field value + Jira, audits both, bumps updated_at', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ jira_number: null })];
      if (text.includes('FROM task_field tf')) {
        return [fieldRow({ task_field_id: 1, is_mandatory: true, dp_name: 'Summary' })];
      }
      if (text.includes('FROM request_field_value')) return [{ task_field_id: 1, value: 'old' }];
      if (text.includes('INSERT INTO request_field_value')) return [{ id: 1 }];
      if (text.includes('UPDATE request')) return [{ id: 555 }];
      if (text.includes('INSERT INTO audit_entry')) return [];
      return [];
    });

    const summary = await store.updateRequest(
      555,
      { jiraNumber: 'JIRA-9', fieldValues: [{ taskFieldId: 1, value: 'new summary' }] },
      supporter,
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
    assert.ok(
      callsWith(calls, 'UPDATE request').some((c) => c.text.includes('updated_at = now()')),
    );
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
      () => store.updateRequest(555, { fieldValues: [{ taskFieldId: 1, value: '' }] }, supporter),
      (e) => e instanceof ApiError && e.code === 'MANDATORY_FIELD',
    );
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
        store.updateRequest(555, { fieldValues: [{ taskFieldId: 1, value: 'not-a-number' }] }, supporter),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });

  it('rejects a field outside the pinned version with UnknownFieldError', async () => {
    const { store } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow()];
      if (text.includes('FROM task_field tf')) return [fieldRow({ task_field_id: 1 })];
      if (text.includes('FROM request_field_value')) return [];
      return [];
    });

    await assert.rejects(
      () => store.updateRequest(555, { fieldValues: [{ taskFieldId: 999, value: 'x' }] }, supporter),
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

    await store.updateRequest(555, { fieldValues: [{ taskFieldId: 1, value: 'same' }] }, supporter);
    assert.equal(callWith(calls, 'INSERT INTO request_field_value'), undefined);
    // No audit for the field; only the updated_at bump UPDATE ran.
    assert.equal(callWith(calls, 'INSERT INTO audit_entry'), undefined);
  });
});

// ── Authorisation (R7.1) ──────────────────────────────────────────────────────

describe('DbRequestSupportMutationsStore.updateRequest — authorisation (R7.1)', () => {
  it('rejects an actor who is not a support member of the request team (FORBIDDEN)', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ team_id: 7 })];
      return [];
    });

    await assert.rejects(
      () => store.updateRequest(555, { jiraNumber: 'JIRA-1' }, outsider),
      (e) => e instanceof RequestForbiddenError && e.requestId === 555,
    );
    // Bailed out before any write.
    assert.equal(callWith(calls, 'INSERT INTO audit_entry'), undefined);
    assert.equal(
      callsWith(calls, 'UPDATE request').find((c) => c.text.includes('jira_number')),
      undefined,
    );
  });

  it('throws RequestNotFoundError for an unknown request', async () => {
    const { store } = makeStore(() => []);
    await assert.rejects(
      () => store.updateRequest(999, { jiraNumber: 'JIRA-1' }, supporter),
      (e) => e instanceof RequestNotFoundError && e.requestId === 999,
    );
  });
});

// ── Status transitions (R9) ─────────────────────────────────────────────────

describe('DbRequestSupportMutationsStore.updateRequest — status (R9)', () => {
  it('applies a LEGAL transition (ASSIGNED → ACTIVE), auditing status old→new', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ status: 'ASSIGNED' })];
      if (text.includes('UPDATE request')) return [{ id: 555 }];
      return [];
    });

    await store.updateRequest(555, { status: 'ACTIVE' }, supporter);

    const statusUpdate = callsWith(calls, 'UPDATE request').find((c) =>
      c.text.includes('status'),
    );
    assert.ok(statusUpdate);
    assert.deepEqual(statusUpdate.params, [555, 'ACTIVE']);
    const auditWrites = callsWith(calls, 'INSERT INTO audit_entry');
    assert.ok(auditWrites.some((c) => c.params.includes('status')));
  });

  it('applies COMPLETE only from ACTIVE (legal)', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ status: 'ACTIVE' })];
      if (text.includes('UPDATE request')) return [{ id: 555 }];
      return [];
    });

    await store.updateRequest(555, { status: 'COMPLETE' }, supporter);
    const statusUpdate = callsWith(calls, 'UPDATE request').find((c) =>
      c.text.includes('status'),
    );
    assert.ok(statusUpdate);
    assert.deepEqual(statusUpdate.params, [555, 'COMPLETE']);
  });

  it('rejects an ILLEGAL transition (NEW → COMPLETE) with INVALID_TRANSITION', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ status: 'NEW' })];
      return [];
    });

    await assert.rejects(
      () => store.updateRequest(555, { status: 'COMPLETE' }, supporter),
      (e) => e instanceof ApiError && e.code === 'INVALID_TRANSITION',
    );
    // No status write happened.
    assert.equal(
      callsWith(calls, 'UPDATE request').find((c) => c.text.includes('status')),
      undefined,
    );
  });

  it('treats setting the same status as a no-op (no write, no audit)', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ status: 'ASSIGNED' })];
      if (text.includes('UPDATE request')) return [{ id: 555 }];
      return [];
    });

    await store.updateRequest(555, { status: 'ASSIGNED' }, supporter);
    assert.equal(callWith(calls, 'INSERT INTO audit_entry'), undefined);
    assert.equal(
      callsWith(calls, 'UPDATE request').find((c) => c.text.includes('status')),
      undefined,
    );
  });

  it('auto-stops-and-records a running timer when the request LEAVES ACTIVE (R8, design decision 3)', async () => {
    // ACTIVE → PAUSED with one open timer on the request: the timer is recorded
    // as a slice and deleted on the same transaction as the status change.
    const openTimer = {
      id: 5,
      request_id: 555,
      member_id: 200,
      started_at: new Date('2026-02-01T10:00:00.000Z'),
    };
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ status: 'ACTIVE' })];
      if (text.includes('UPDATE request')) return [{ id: 555 }];
      if (text.includes('FROM active_timer\n  WHERE request_id = $1')) return [openTimer];
      if (text.includes('INSERT INTO time_slice')) {
        return [
          {
            id: 77,
            request_id: 555,
            member_id: 200,
            started_at: openTimer.started_at,
            ended_at: new Date('2026-02-01T10:30:00.000Z'),
            duration_minutes: 30,
          },
        ];
      }
      if (text.includes('DELETE FROM active_timer')) return [{ id: 5 }];
      return [];
    });

    await store.updateRequest(555, { status: 'PAUSED' }, supporter);

    // Status changed, and the open timer was recorded + cleared.
    assert.ok(
      callsWith(calls, 'UPDATE request').some((c) => c.text.includes('status')),
    );
    assert.ok(callWith(calls, 'INSERT INTO time_slice'));
    assert.ok(callWith(calls, 'DELETE FROM active_timer'));
  });

  it('does NOT auto-stop timers when a status change does not leave ACTIVE', async () => {
    // ASSIGNED → ACTIVE (entering ACTIVE) must not touch timers.
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ status: 'ASSIGNED' })];
      if (text.includes('UPDATE request')) return [{ id: 555 }];
      return [];
    });

    await store.updateRequest(555, { status: 'ACTIVE' }, supporter);
    assert.equal(callWith(calls, 'FROM active_timer\n  WHERE request_id = $1'), undefined);
    assert.equal(callWith(calls, 'INSERT INTO time_slice'), undefined);
  });
});

// ── Assignment (R7.2) ─────────────────────────────────────────────────────────

describe('DbRequestSupportMutationsStore.updateRequest — assignment (R7.2)', () => {
  it('assigns to a member of the request team, auditing the change', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ assigned_member_id: null, team_id: 7 })];
      if (text.includes('FROM team_member')) return [{ is_member: true }];
      if (text.includes('UPDATE request')) return [{ id: 555 }];
      return [];
    });

    await store.updateRequest(555, { assignedMemberId: 250 }, supporter);

    // Membership was checked against the request's team.
    const membership = callWith(calls, 'FROM team_member');
    assert.ok(membership);
    assert.deepEqual(membership.params, [7, 250]);
    // Assignment written + audited.
    const assignUpdate = callsWith(calls, 'UPDATE request').find((c) =>
      c.text.includes('assigned_member_id'),
    );
    assert.ok(assignUpdate);
    assert.deepEqual(assignUpdate.params, [555, 250]);
    assert.ok(
      callsWith(calls, 'INSERT INTO audit_entry').some((c) =>
        c.params.includes('assigned_member_id'),
      ),
    );
  });

  it('rejects assigning to a NON-member of the request team (VALIDATION_FAILED)', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ team_id: 7 })];
      if (text.includes('FROM team_member')) return [{ is_member: false }];
      return [];
    });

    await assert.rejects(
      () => store.updateRequest(555, { assignedMemberId: 999 }, supporter),
      (e) => e instanceof AssigneeNotInTeamError && e.assigneeId === 999 && e.teamId === 7,
    );
    // No assignment write happened.
    assert.equal(
      callsWith(calls, 'UPDATE request').find((c) => c.text.includes('assigned_member_id')),
      undefined,
    );
  });

  it('unassigns (assignedMemberId=null) without a membership check, auditing the change', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ assigned_member_id: 250, team_id: 7 })];
      if (text.includes('UPDATE request')) return [{ id: 555 }];
      return [];
    });

    await store.updateRequest(555, { assignedMemberId: null }, supporter);

    // No membership lookup for an unassign.
    assert.equal(callWith(calls, 'FROM team_member'), undefined);
    const assignUpdate = callsWith(calls, 'UPDATE request').find((c) =>
      c.text.includes('assigned_member_id'),
    );
    assert.ok(assignUpdate);
    assert.deepEqual(assignUpdate.params, [555, null]);
    assert.ok(
      callsWith(calls, 'INSERT INTO audit_entry').some((c) =>
        c.params.includes('assigned_member_id'),
      ),
    );
  });

  it('treats re-assigning the same member as a no-op (no write, no audit)', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow({ assigned_member_id: 250, team_id: 7 })];
      if (text.includes('UPDATE request')) return [{ id: 555 }];
      return [];
    });

    await store.updateRequest(555, { assignedMemberId: 250 }, supporter);
    assert.equal(callWith(calls, 'FROM team_member'), undefined);
    assert.equal(
      callsWith(calls, 'UPDATE request').find((c) => c.text.includes('assigned_member_id')),
      undefined,
    );
  });
});

// ── Audit-in-transaction (R17) ─────────────────────────────────────────────────

describe('DbRequestSupportMutationsStore.updateRequest — audit in transaction (R17)', () => {
  it('runs the field write, status change, assignment, and audits on the SAME tx client', async () => {
    // Every call is recorded on the single fake db handed to the pass-through
    // runner, so the audit rows share the mutation's transaction (R17): if any
    // step threw, the whole runner would reject and nothing would commit.
    const seenOnTx: string[] = [];
    const { store } = makeStore((text) => {
      seenOnTx.push(text);
      if (text.includes('FROM request r')) return [headerRow({ status: 'ASSIGNED', team_id: 7 })];
      if (text.includes('FROM task_field tf')) return [fieldRow({ task_field_id: 1 })];
      if (text.includes('FROM request_field_value')) return [{ task_field_id: 1, value: 'old' }];
      if (text.includes('FROM team_member')) return [{ is_member: true }];
      if (text.includes('INSERT INTO request_field_value')) return [{ id: 1 }];
      if (text.includes('UPDATE request')) return [{ id: 555 }];
      if (text.includes('INSERT INTO audit_entry')) return [];
      return [];
    });

    await store.updateRequest(
      555,
      {
        fieldValues: [{ taskFieldId: 1, value: 'new' }],
        status: 'ACTIVE',
        assignedMemberId: 250,
      },
      supporter,
    );

    // The field-value insert, status/assignment updates, and their audit
    // inserts all ran through the same recorded queryable.
    assert.ok(seenOnTx.some((t) => t.includes('INSERT INTO request_field_value')));
    assert.ok(seenOnTx.some((t) => t.includes('INSERT INTO audit_entry')));
    assert.ok(seenOnTx.some((t) => t.includes('UPDATE request')));
  });
});
