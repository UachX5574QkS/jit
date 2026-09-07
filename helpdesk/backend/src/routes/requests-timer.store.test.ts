import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Queryable } from '../db/query.js';
import { ApiError } from '../middleware/errors.js';
import { AuditWriter } from '../audit/index.js';
import {
  DbRequestTimerStore,
  NoOpenTimerError,
  TimerForbiddenError,
  TimerNotActiveError,
  TimerRequestNotFoundError,
  autoStopTimersForRequest,
  elapsedMinutes,
  type TimerActor,
  type TransactionRunner,
} from './requests-timer.store.js';

/**
 * Tests for the Postgres-backed time-tracking store (design: "Time tracking";
 * R8). A fake {@link Queryable} answers the store's SELECT/INSERT/DELETE
 * statements by matching SQL fragments and records every call; the transaction
 * runner is a pass-through — so the ACTIVE-only start guard, the concurrent
 * timer prompt/resolution, the ">1 minute" edit rule, the slice recording, and
 * the leave-ACTIVE auto-stop are exercised WITHOUT a live database.
 */

interface RecordedCall {
  readonly text: string;
  readonly params: readonly unknown[];
}

/** The request team+status row the start/stop guard reads. */
function requestRow(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: 555, team_id: 7, status: 'ACTIVE', ...overrides };
}

/** An active_timer row. */
function timerRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    request_id: 555,
    member_id: 200,
    started_at: new Date('2026-02-01T10:00:00.000Z'),
    ...overrides,
  };
}

/** A time_slice row returned from the insert. */
function sliceRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 9,
    request_id: 555,
    member_id: 200,
    started_at: new Date('2026-02-01T10:00:00.000Z'),
    ended_at: new Date('2026-02-01T10:30:00.000Z'),
    duration_minutes: 30,
    ...overrides,
  };
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

function makeStore(responder: (text: string, params: readonly unknown[]) => unknown[]) {
  const fake = fakeDb(responder);
  const audit = new AuditWriter(fake.db);
  const store = new DbRequestTimerStore(audit, fake.runTransaction);
  return { store, ...fake, audit };
}

function callWith(calls: RecordedCall[], fragment: string): RecordedCall | undefined {
  return calls.find((c) => c.text.includes(fragment));
}
function callsWith(calls: RecordedCall[], fragment: string): RecordedCall[] {
  return calls.filter((c) => c.text.includes(fragment));
}

/** A support member of the request's team (team 7). */
const supporter: TimerActor = { userId: 200, teamsMemberOf: [7] };
/** A user not in the request's team. */
const outsider: TimerActor = { userId: 300, teamsMemberOf: [8] };

// ── elapsedMinutes (R8.4) ─────────────────────────────────────────────────────

describe('elapsedMinutes (R8.4)', () => {
  it('rounds to whole minutes', () => {
    const start = new Date('2026-02-01T10:00:00.000Z');
    assert.equal(elapsedMinutes(start, new Date('2026-02-01T10:30:00.000Z')), 30);
    assert.equal(elapsedMinutes(start, new Date('2026-02-01T10:30:40.000Z')), 31);
  });

  it('clamps a sub-minute elapsed to the stored minimum of 1', () => {
    const start = new Date('2026-02-01T10:00:00.000Z');
    assert.equal(elapsedMinutes(start, new Date('2026-02-01T10:00:10.000Z')), 1);
    assert.equal(elapsedMinutes(start, start), 1);
  });
});

// ── startTimer (R8.1, R8.2) ───────────────────────────────────────────────────

describe('DbRequestTimerStore.startTimer — ACTIVE-only + open (R8.1, R8.2)', () => {
  it('opens a timer when ACTIVE, without changing status, and audits it', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request WHERE id')) return [requestRow({ status: 'ACTIVE' })];
      if (text.includes('active_timer\n  WHERE request_id = $1 AND member_id')) return [];
      if (text.includes('WHERE member_id = $1')) return [];
      if (text.includes('INSERT INTO active_timer')) return [timerRow()];
      return [];
    });

    const result = await store.startTimer(555, {}, supporter);

    assert.equal(result.timer.requestId, 555);
    assert.equal(result.timer.memberId, 200);
    assert.equal(result.stoppedOthers, false);
    // A timer row was inserted; status was never updated.
    assert.ok(callWith(calls, 'INSERT INTO active_timer'));
    assert.equal(callWith(calls, 'UPDATE request'), undefined);
    // The open was audited on active_timer.
    assert.ok(
      callsWith(calls, 'INSERT INTO audit_entry').some((c) =>
        c.params.includes('active_timer'),
      ),
    );
  });

  it('rejects starting when the request is NOT ACTIVE (INVALID_TRANSITION)', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request WHERE id')) return [requestRow({ status: 'ASSIGNED' })];
      return [];
    });

    await assert.rejects(
      () => store.startTimer(555, {}, supporter),
      (e) => e instanceof TimerNotActiveError && e.status === 'ASSIGNED',
    );
    assert.equal(callWith(calls, 'INSERT INTO active_timer'), undefined);
  });

  it('is idempotent: returns the existing open timer without inserting a second', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request WHERE id')) return [requestRow({ status: 'ACTIVE' })];
      if (text.includes('active_timer\n  WHERE request_id = $1 AND member_id')) return [timerRow({ id: 42 })];
      if (text.includes('WHERE member_id = $1')) return [timerRow({ id: 42 })];
      return [];
    });

    const result = await store.startTimer(555, {}, supporter);
    assert.equal(result.timer.id, 42);
    assert.equal(callWith(calls, 'INSERT INTO active_timer'), undefined);
  });

  it('rejects a non-support-member actor (FORBIDDEN)', async () => {
    const { store } = makeStore((text) => {
      if (text.includes('FROM request WHERE id')) return [requestRow({ team_id: 7 })];
      return [];
    });
    await assert.rejects(
      () => store.startTimer(555, {}, outsider),
      (e) => e instanceof TimerForbiddenError && e.requestId === 555,
    );
  });

  it('throws TimerRequestNotFoundError for an unknown request', async () => {
    const { store } = makeStore(() => []);
    await assert.rejects(
      () => store.startTimer(999, {}, supporter),
      (e) => e instanceof TimerRequestNotFoundError && e.requestId === 999,
    );
  });
});

// ── concurrent-timer prompt resolution (R8.8) ─────────────────────────────────

describe('DbRequestTimerStore.startTimer — concurrent-timer prompt (R8.8)', () => {
  it('leaves OTHER open timers running by default and reports them', async () => {
    const other = timerRow({ id: 2, request_id: 900, started_at: new Date('2026-02-01T09:00:00.000Z') });
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request WHERE id')) return [requestRow({ status: 'ACTIVE' })];
      if (text.includes('active_timer\n  WHERE request_id = $1 AND member_id')) return [];
      if (text.includes('WHERE member_id = $1')) return [other];
      if (text.includes('INSERT INTO active_timer')) return [timerRow()];
      return [];
    });

    const result = await store.startTimer(555, {}, supporter);
    assert.equal(result.otherOpenTimers.length, 1);
    assert.equal(result.otherOpenTimers[0]!.requestId, 900);
    assert.equal(result.stoppedOthers, false);
    // The other timer was NOT recorded/deleted.
    assert.equal(callWith(calls, 'INSERT INTO time_slice'), undefined);
    assert.equal(callWith(calls, 'DELETE FROM active_timer'), undefined);
  });

  it('stopOthers:true auto-stops-and-records the OTHER open timers first', async () => {
    const other = timerRow({ id: 2, request_id: 900, started_at: new Date('2026-02-01T09:00:00.000Z') });
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request WHERE id')) return [requestRow({ status: 'ACTIVE' })];
      if (text.includes('active_timer\n  WHERE request_id = $1 AND member_id')) return [];
      if (text.includes('WHERE member_id = $1')) return [other];
      if (text.includes('INSERT INTO time_slice')) return [sliceRow({ request_id: 900 })];
      if (text.includes('DELETE FROM active_timer')) return [{ id: 2 }];
      if (text.includes('INSERT INTO active_timer')) return [timerRow()];
      return [];
    });

    const result = await store.startTimer(555, { stopOthers: true }, supporter);
    assert.equal(result.stoppedOthers, true);
    // A slice was recorded for the OTHER request and its timer deleted.
    const slice = callWith(calls, 'INSERT INTO time_slice');
    assert.ok(slice);
    assert.equal(slice.params[0], 900);
    assert.deepEqual(callWith(calls, 'DELETE FROM active_timer')!.params, [2]);
    // And this request's timer was opened.
    assert.deepEqual(callWith(calls, 'INSERT INTO active_timer')!.params, [555, 200]);
  });

  it('stopOthers:true is a no-op when there are no other open timers', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request WHERE id')) return [requestRow({ status: 'ACTIVE' })];
      if (text.includes('active_timer\n  WHERE request_id = $1 AND member_id')) return [];
      if (text.includes('WHERE member_id = $1')) return [];
      if (text.includes('INSERT INTO active_timer')) return [timerRow()];
      return [];
    });
    const result = await store.startTimer(555, { stopOthers: true }, supporter);
    assert.equal(result.stoppedOthers, false);
    assert.equal(callWith(calls, 'INSERT INTO time_slice'), undefined);
  });
});

// ── stopTimer (R8.4–8.6) ──────────────────────────────────────────────────────

describe('DbRequestTimerStore.stopTimer — record slice (R8.4–8.6)', () => {
  it('records a slice with the ELAPSED duration and the member, deleting the timer', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request WHERE id')) return [requestRow({ status: 'ACTIVE' })];
      if (text.includes('active_timer\n  WHERE request_id = $1 AND member_id')) return [timerRow()];
      if (text.includes('INSERT INTO time_slice')) return [sliceRow()];
      if (text.includes('DELETE FROM active_timer')) return [{ id: 1 }];
      return [];
    });

    const slice = await store.stopTimer(555, {}, supporter);
    assert.equal(slice.requestId, 555);
    assert.equal(slice.memberId, 200);
    // The slice insert carried request, member, and a computed duration.
    const insert = callWith(calls, 'INSERT INTO time_slice')!;
    assert.equal(insert.params[0], 555);
    assert.equal(insert.params[1], 200);
    // Timer deleted; creation audited.
    assert.ok(callWith(calls, 'DELETE FROM active_timer'));
    assert.ok(
      callsWith(calls, 'INSERT INTO audit_entry').some((c) => c.params.includes('time_slice')),
    );
  });

  it('records an EDITED duration when it is > 1 minute', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request WHERE id')) return [requestRow({ status: 'ACTIVE' })];
      if (text.includes('active_timer\n  WHERE request_id = $1 AND member_id')) return [timerRow()];
      if (text.includes('INSERT INTO time_slice')) return [sliceRow({ duration_minutes: 5 })];
      if (text.includes('DELETE FROM active_timer')) return [{ id: 1 }];
      return [];
    });

    const slice = await store.stopTimer(555, { durationMinutes: 5 }, supporter);
    assert.equal(slice.durationMinutes, 5);
    // The edited value (5) was written as the duration.
    assert.equal(callWith(calls, 'INSERT INTO time_slice')!.params[4], 5);
  });

  it('rejects an edited duration of exactly 1 minute with TIMER_MIN_DURATION', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request WHERE id')) return [requestRow({ status: 'ACTIVE' })];
      if (text.includes('active_timer\n  WHERE request_id = $1 AND member_id')) return [timerRow()];
      return [];
    });

    await assert.rejects(
      () => store.stopTimer(555, { durationMinutes: 1 }, supporter),
      (e) => e instanceof ApiError && e.code === 'TIMER_MIN_DURATION',
    );
    assert.equal(callWith(calls, 'INSERT INTO time_slice'), undefined);
  });

  it('rejects an edited duration of 0 with TIMER_MIN_DURATION', async () => {
    const { store } = makeStore((text) => {
      if (text.includes('FROM request WHERE id')) return [requestRow({ status: 'ACTIVE' })];
      if (text.includes('active_timer\n  WHERE request_id = $1 AND member_id')) return [timerRow()];
      return [];
    });
    await assert.rejects(
      () => store.stopTimer(555, { durationMinutes: 0 }, supporter),
      (e) => e instanceof ApiError && e.code === 'TIMER_MIN_DURATION',
    );
  });

  it('throws NoOpenTimerError when the member has no open timer to stop', async () => {
    const { store } = makeStore((text) => {
      if (text.includes('FROM request WHERE id')) return [requestRow({ status: 'ACTIVE' })];
      if (text.includes('active_timer\n  WHERE request_id = $1 AND member_id')) return [];
      return [];
    });
    await assert.rejects(
      () => store.stopTimer(555, {}, supporter),
      (e) => e instanceof NoOpenTimerError && e.requestId === 555 && e.memberId === 200,
    );
  });

  it('allows stopping regardless of current status (a request may have left ACTIVE)', async () => {
    // A timer can still be manually closed if the request is now PAUSED, e.g.
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request WHERE id')) return [requestRow({ status: 'PAUSED' })];
      if (text.includes('active_timer\n  WHERE request_id = $1 AND member_id')) return [timerRow()];
      if (text.includes('INSERT INTO time_slice')) return [sliceRow()];
      if (text.includes('DELETE FROM active_timer')) return [{ id: 1 }];
      return [];
    });
    await store.stopTimer(555, {}, supporter);
    assert.ok(callWith(calls, 'INSERT INTO time_slice'));
  });
});

// ── autoStopTimersForRequest (design decision 3) ──────────────────────────────

describe('autoStopTimersForRequest — leave-ACTIVE auto-record (design decision 3)', () => {
  it('records a slice and deletes each open timer on the request', async () => {
    const t1 = timerRow({ id: 1, member_id: 200 });
    const t2 = timerRow({ id: 2, member_id: 201 });
    const calls: RecordedCall[] = [];
    const db = {
      query: async (text: string, params?: unknown[]) => {
        calls.push({ text, params: params ?? [] });
        if (text.includes('FROM active_timer\n  WHERE request_id = $1')) return { rows: [t1, t2] } as never;
        if (text.includes('INSERT INTO time_slice')) return { rows: [sliceRow()] } as never;
        if (text.includes('DELETE FROM active_timer')) return { rows: [{ id: 1 }] } as never;
        return { rows: [] } as never;
      },
    } as unknown as Queryable;

    const recorded = await autoStopTimersForRequest(
      555,
      new Date('2026-02-01T11:00:00.000Z'),
      db,
      new AuditWriter(db),
    );

    assert.equal(recorded.length, 2);
    // Two slices inserted, two timers deleted.
    assert.equal(callsWith(calls, 'INSERT INTO time_slice').length, 2);
    assert.equal(callsWith(calls, 'DELETE FROM active_timer').length, 2);
  });

  it('is a no-op (empty result, no writes) when no timers are running', async () => {
    const calls: RecordedCall[] = [];
    const db = {
      query: async (text: string, params?: unknown[]) => {
        calls.push({ text, params: params ?? [] });
        return { rows: [] } as never;
      },
    } as unknown as Queryable;

    const recorded = await autoStopTimersForRequest(555, new Date(), db, new AuditWriter(db));
    assert.equal(recorded.length, 0);
    assert.equal(callWith(calls, 'INSERT INTO time_slice'), undefined);
    assert.equal(callWith(calls, 'DELETE FROM active_timer'), undefined);
  });
});
