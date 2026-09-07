import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Queryable } from '../db/query.js';
import {
  DbEstimatedEffortStore,
  TaskNotFoundError,
} from './requests-estimated-effort.store.js';

/**
 * Tests for the Postgres-backed Estimated-Effort store (design: "Requests (user
 * side)" — `GET /api/tasks/{taskId}/estimated-effort` — type-level average;
 * R4.7). A fake {@link Queryable} answers the store's two SELECTs (task-exists
 * probe, then the aggregate) from a scripted response and records every call
 * (SQL + bound params) — so the average maths, the null / zero cases, and the
 * parameterisation invariant are exercised WITHOUT a live database, matching the
 * request-list store test style.
 *
 * The key invariants asserted throughout:
 *   • R4.7 maths: SUM(slice minutes over COMPLETE requests) ÷ COUNT(COMPLETE
 *     requests) — both halves scoped to complete requests; non-complete slices
 *     are excluded by the SQL (`r.status = 'COMPLETE'`), aggregated across ALL
 *     versions of the task (`tv.task_id = $1`).
 *   • Zero complete requests → a null estimate, returned cleanly (no divide by
 *     zero).
 *   • Unknown task → {@link TaskNotFoundError} (route maps to 404).
 *   • No value is interpolated into the SQL text — the task id and the COMPLETE
 *     status both travel as bound parameters (R22.2).
 */

interface RecordedCall {
  readonly text: string;
  readonly params: readonly unknown[];
}

/**
 * A fake queryable that answers each `query` call from `responses` in order and
 * records the call. The store issues the task-exists probe first, then the
 * aggregate; a `null`/empty first response models an unknown task (the store
 * short-circuits before the aggregate).
 */
function fakeDb(responses: unknown[][]): { db: Queryable; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let i = 0;
  const db = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params: params ?? [] });
      const rows = responses[i] ?? [];
      i += 1;
      return { rows, rowCount: rows.length } as never;
    },
  } as unknown as Queryable;
  return { db, calls };
}

/** The task-exists probe: one row means the task exists. */
const taskExists = [{ id: 42 }];

/** The single aggregate SELECT the store issues after the existence probe. */
function aggregateCall(calls: RecordedCall[]): RecordedCall {
  const call = calls.find((c) => c.text.includes('total_slice_minutes'));
  assert.ok(call, 'expected the aggregate SELECT to be issued');
  return call;
}

// ── R4.7 maths: average over COMPLETE requests only ─────────────────────────────

describe('DbEstimatedEffortStore.getEstimatedEffort — average (R4.7)', () => {
  it('divides total slice minutes by the number of complete requests', async () => {
    // 3 complete requests, 180 total slice minutes across them → 60.
    const { db } = fakeDb([
      taskExists,
      [{ completed_count: 3, total_slice_minutes: 180 }],
    ]);
    const store = new DbEstimatedEffortStore(db);

    const view = await store.getEstimatedEffort(42);

    assert.deepEqual(view, {
      taskId: 42,
      completedCount: 3,
      totalSliceMinutes: 180,
      estimatedEffortMinutes: 60,
    });
  });

  it('coerces pg string aggregate values into numbers (COUNT/SUM come back as text)', async () => {
    const { db } = fakeDb([
      taskExists,
      [{ completed_count: '4', total_slice_minutes: '90' }],
    ]);
    const store = new DbEstimatedEffortStore(db);

    const view = await store.getEstimatedEffort(42);

    assert.strictEqual(view.completedCount, 4);
    assert.strictEqual(view.totalSliceMinutes, 90);
    assert.strictEqual(view.estimatedEffortMinutes, 22.5);
  });

  it('scopes both halves to COMPLETE requests and all versions of the task in the SQL', async () => {
    // The store cannot "see" non-complete slices in a unit test — the exclusion
    // lives in the SQL. Assert the query only counts COMPLETE requests (bound,
    // not interpolated) and aggregates across every version via tv.task_id.
    const { db, calls } = fakeDb([
      taskExists,
      [{ completed_count: 2, total_slice_minutes: 30 }],
    ]);
    const store = new DbEstimatedEffortStore(db);

    await store.getEstimatedEffort(42);

    const call = aggregateCall(calls);
    // Task id + COMPLETE status are the only bound params; neither is in the text.
    assert.deepEqual(call.params, [42, 'COMPLETE']);
    assert.ok(!call.text.includes('COMPLETE'), 'status must be bound, not interpolated');
    assert.match(call.text, /r\.status = \$2::request_status/);
    // Aggregated over ALL versions of the task type (R16.4).
    assert.match(call.text, /JOIN task_version tv ON tv\.id = r\.task_version_id/);
    assert.match(call.text, /tv\.task_id = \$1/);
    // Slices summed via LEFT JOIN so a complete request with no slices still counts.
    assert.match(call.text, /LEFT JOIN time_slice ts ON ts\.request_id = r\.id/);
    assert.match(call.text, /COUNT\(DISTINCT r\.id\)/);
    assert.match(call.text, /COALESCE\(SUM\(ts\.duration_minutes\), 0\)/);
  });

  it('multi-version aggregation: a single task-level task id drives the whole aggregate', async () => {
    // With versions folded together the SQL binds exactly one task id; the
    // aggregate row is the combined total the DB returns for all versions.
    const { db, calls } = fakeDb([
      taskExists,
      [{ completed_count: 5, total_slice_minutes: 250 }],
    ]);
    const store = new DbEstimatedEffortStore(db);

    const view = await store.getEstimatedEffort(42);

    assert.equal(view.estimatedEffortMinutes, 50);
    // Exactly one task id bound — versions are unioned in SQL, not per-version calls.
    assert.equal(
      aggregateCall(calls).params.filter((p) => p === 42).length,
      1,
    );
    // Only two SELECTs total: existence probe + one aggregate.
    assert.equal(calls.length, 2);
  });

  it('complete requests with no recorded slices yield a clean 0 average (distinct from null)', async () => {
    const { db } = fakeDb([
      taskExists,
      [{ completed_count: 2, total_slice_minutes: 0 }],
    ]);
    const store = new DbEstimatedEffortStore(db);

    const view = await store.getEstimatedEffort(42);

    assert.strictEqual(view.completedCount, 2);
    assert.strictEqual(view.totalSliceMinutes, 0);
    assert.strictEqual(view.estimatedEffortMinutes, 0);
  });
});

// ── Zero completed → null estimate (R4.7) ───────────────────────────────────────

describe('DbEstimatedEffortStore.getEstimatedEffort — no complete requests (R4.7)', () => {
  it('returns a null estimate with zero components when the type has no complete requests', async () => {
    const { db } = fakeDb([
      taskExists,
      [{ completed_count: 0, total_slice_minutes: 0 }],
    ]);
    const store = new DbEstimatedEffortStore(db);

    const view = await store.getEstimatedEffort(42);

    assert.deepEqual(view, {
      taskId: 42,
      completedCount: 0,
      totalSliceMinutes: 0,
      estimatedEffortMinutes: null,
    });
  });

  it('treats a missing aggregate row as zero completed (null estimate)', async () => {
    // Defensive: even if the aggregate SELECT somehow returns no row, the store
    // must not divide by zero — it reports 0 completed and a null estimate.
    const { db } = fakeDb([taskExists, []]);
    const store = new DbEstimatedEffortStore(db);

    const view = await store.getEstimatedEffort(42);

    assert.equal(view.completedCount, 0);
    assert.equal(view.estimatedEffortMinutes, null);
  });
});

// ── Unknown task → 404 (via TaskNotFoundError) ──────────────────────────────────

describe('DbEstimatedEffortStore.getEstimatedEffort — unknown task', () => {
  it('throws TaskNotFoundError when the task does not exist and never runs the aggregate', async () => {
    const { db, calls } = fakeDb([[] /* task-exists probe: no row */]);
    const store = new DbEstimatedEffortStore(db);

    await assert.rejects(() => store.getEstimatedEffort(999), (err: unknown) => {
      assert.ok(err instanceof TaskNotFoundError);
      assert.equal((err as TaskNotFoundError).taskId, 999);
      return true;
    });

    // Short-circuits after the existence probe; the aggregate is never issued.
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.text, /FROM task WHERE id = \$1/);
    assert.deepEqual(calls[0]!.params, [999]);
    assert.equal(calls.find((c) => c.text.includes('total_slice_minutes')), undefined);
  });
});
