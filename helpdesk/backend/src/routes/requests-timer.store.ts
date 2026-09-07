import { one, many, withTransaction, type Queryable } from '../db/query.js';
import { AuditWriter } from '../audit/index.js';
import { errors } from '../middleware/errors.js';
import { isStatus, type Status } from '../status/index.js';

/**
 * Data-access + logic for time tracking (design: "Time tracking", R8).
 *
 * ── Why an interface + a DB implementation ───────────────────────────────────
 * The route handler (requests-timer.routes.ts) depends on the narrow
 * {@link RequestTimerStore} interface, never on `pg` directly, so it unit-tests
 * with an in-memory fake — matching the injectable style of the other request
 * stores. The production {@link DbRequestTimerStore} is the only place that
 * talks to Postgres, and only through the parameterised data-access layer
 * (`db/query.ts`): every value travels as a bound placeholder.
 *
 * ── The operations ───────────────────────────────────────────────────────────
 *   • startTimer   — begin a timer for a member on a request. Allowed ONLY when
 *                    the request status is ACTIVE (R8.1, R8.2); status is not
 *                    changed (R8.2). At most one OPEN timer per (request,
 *                    member) — a re-click while one runs on THIS request is a
 *                    no-op returning the existing timer (the unique index
 *                    enforces this). When the member already has open timers on
 *                    OTHER requests, the caller must resolve the concurrent
 *                    prompt (R8.8): with `stopOthers:false` (or unspecified) the
 *                    others are LEFT running; with `stopOthers:true` each other
 *                    open timer is auto-stopped-and-recorded first.
 *   • stopTimer    — stop the member's OPEN timer on a request and record a
 *                    time_slice (R8.4–8.6). The recorded duration defaults to
 *                    the elapsed minutes; the caller may override it, in which
 *                    case the edited value MUST be > 1 minute (R8.5,
 *                    TIMER_MIN_DURATION otherwise). The slice retains the
 *                    duration and the member who recorded it (R8.6).
 *   • listMyTimers — the current user's OPEN timers (across requests), used by
 *                    the UI to drive the concurrent-timer prompt (R8.8).
 *
 * ── Auto-stop-and-record on leaving ACTIVE (design decision 3) ───────────────
 * {@link autoStopTimersForRequest} stops EVERY open timer on a request and
 * records a slice for each, up to the moment it is called. It is invoked when a
 * request leaves ACTIVE (from the support-side status change) so a running
 * timer is never silently discarded. It runs on the caller's transaction so it
 * commits/rolls back atomically with the status change.
 *
 * ── Duration semantics (R8.4, R8.5) ──────────────────────────────────────────
 * The elapsed duration is computed from `started_at` to the stop moment and
 * rounded to whole minutes (the UI presents days/hours/minutes; the store keeps
 * minutes, R8.4). The stored minimum is 1 minute (the DB CHECK), so an elapsed
 * time under a minute is recorded as 1. An EDITED duration is the only value
 * subject to the "> 1 minute" rule (R8.5): editing to 1 or below is rejected.
 */

// ── Shared error types (mapped to the uniform envelope by the route layer) ─────

/** Raised when the request id does not exist. Mapped to 404 NOT_FOUND. */
export class TimerRequestNotFoundError extends Error {
  constructor(readonly requestId: number) {
    super(`Request ${requestId} not found`);
    this.name = 'TimerRequestNotFoundError';
  }
}

/**
 * Raised when the actor is not a support member of the request's team (R7 —
 * only support members work requests; R8 is a support activity). Mapped to 403
 * FORBIDDEN.
 */
export class TimerForbiddenError extends Error {
  constructor(readonly requestId: number, message?: string) {
    super(message ?? `Not permitted to time request ${requestId}`);
    this.name = 'TimerForbiddenError';
  }
}

/**
 * Raised when a timer start is attempted while the request is not ACTIVE (R8.1
 * — the "Working on It" button only exists in ACTIVE). Mapped to
 * INVALID_TRANSITION (409): it is a conflict with the request's current state.
 */
export class TimerNotActiveError extends Error {
  constructor(readonly requestId: number, readonly status: Status) {
    super(`A timer can only be started while a request is ACTIVE (was ${status})`);
    this.name = 'TimerNotActiveError';
  }
}

/**
 * Raised when a stop is attempted but the member has no OPEN timer on the
 * request. Mapped to 404 NOT_FOUND — there is nothing to stop.
 */
export class NoOpenTimerError extends Error {
  constructor(readonly requestId: number, readonly memberId: number) {
    super(`No open timer for member ${memberId} on request ${requestId}`);
    this.name = 'NoOpenTimerError';
  }
}

// ── Public input / output shapes (camelCase, ISO dates) ────────────────────────

/** The actor context: their id and the teams they are a member of (R7, R8). */
export interface TimerActor {
  /** The current user's `app_user.id`. */
  readonly userId: number;
  /** The current user's team memberships (support-member test). */
  readonly teamsMemberOf: ReadonlyArray<number>;
}

/** A running (open) timer, as returned to the UI (camelCase, ISO dates). */
export interface OpenTimer {
  readonly id: number;
  readonly requestId: number;
  readonly memberId: number;
  readonly startedAt: string;
}

/** The result of starting a timer (R8.2, R8.8). */
export interface StartTimerResult {
  /** The member's open timer on this request (existing or newly created). */
  readonly timer: OpenTimer;
  /**
   * The member's OTHER open timers at the moment of starting (on different
   * requests). Non-empty means the UI SHOULD have shown the concurrent-timer
   * prompt (R8.8); when `stopOthers` was true these were auto-stopped and this
   * lists what was stopped, otherwise they were left running.
   */
  readonly otherOpenTimers: readonly OpenTimer[];
  /** Whether the OTHER open timers were auto-stopped (R8.8). */
  readonly stoppedOthers: boolean;
}

/** A recorded time slice (R8.6). */
export interface RecordedSlice {
  readonly id: number;
  readonly requestId: number;
  readonly memberId: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMinutes: number;
}

/** Input for {@link RequestTimerStore.startTimer}. */
export interface StartTimerInput {
  /**
   * Resolution of the concurrent-timer prompt (R8.8). When the member has open
   * timers on OTHER requests: `true` stops-and-records them first; `false`/
   * omitted leaves them running.
   */
  readonly stopOthers?: boolean;
}

/** Input for {@link RequestTimerStore.stopTimer}. */
export interface StopTimerInput {
  /**
   * An edited duration in minutes (R8.5). When provided it MUST be > 1 minute,
   * else TIMER_MIN_DURATION. When omitted, the elapsed duration is recorded.
   */
  readonly durationMinutes?: number;
}

/** The narrow contract the route handler depends on. */
export interface RequestTimerStore {
  /**
   * Start a timer for the actor on a request (R8.1, R8.2, R8.8). Throws
   * {@link TimerRequestNotFoundError} / {@link TimerForbiddenError} /
   * {@link TimerNotActiveError}.
   */
  startTimer(
    requestId: number,
    input: StartTimerInput,
    actor: TimerActor,
  ): Promise<StartTimerResult>;

  /**
   * Stop the actor's open timer on a request and record a slice (R8.4–8.6).
   * Throws {@link TimerRequestNotFoundError} / {@link TimerForbiddenError} /
   * {@link NoOpenTimerError}; an edited duration ≤ 1 minute surfaces as
   * TIMER_MIN_DURATION.
   */
  stopTimer(
    requestId: number,
    input: StopTimerInput,
    actor: TimerActor,
  ): Promise<RecordedSlice>;

  /** The actor's open timers across all requests (R8.8). */
  listMyTimers(actor: TimerActor): Promise<OpenTimer[]>;
}

// ── DB row shapes ─────────────────────────────────────────────────────────────

interface RequestTeamStatusRow {
  id: string | number;
  team_id: string | number;
  status: string;
}

interface ActiveTimerRow {
  id: string | number;
  request_id: string | number;
  member_id: string | number;
  started_at: Date | string;
}

interface TimeSliceRow {
  id: string | number;
  request_id: string | number;
  member_id: string | number;
  started_at: Date | string;
  ended_at: Date | string;
  duration_minutes: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** ISO-8601 UTC string for a `timestamptz` value (design: dates as ISO-8601). */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Normalise a `Date | string` into a `Date`. */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toOpenTimer(row: ActiveTimerRow): OpenTimer {
  return {
    id: Number(row.id),
    requestId: Number(row.request_id),
    memberId: Number(row.member_id),
    startedAt: toIso(row.started_at),
  };
}

function toRecordedSlice(row: TimeSliceRow): RecordedSlice {
  return {
    id: Number(row.id),
    requestId: Number(row.request_id),
    memberId: Number(row.member_id),
    startedAt: toIso(row.started_at),
    endedAt: toIso(row.ended_at),
    durationMinutes: Number(row.duration_minutes),
  };
}

/**
 * Whole minutes between `start` and `end`, clamped to a minimum of 1 (R8.4 —
 * the presented duration is in days/hours/minutes; the store persists minutes,
 * and the DB CHECK enforces >= 1). An elapsed time under a minute records as 1.
 */
export function elapsedMinutes(start: Date, end: Date): number {
  const ms = end.getTime() - start.getTime();
  const minutes = Math.round(ms / 60000);
  return minutes < 1 ? 1 : minutes;
}

/**
 * A runner that executes `fn` inside a single database transaction. Production
 * uses {@link withTransaction}; tests inject a pass-through backed by a fake
 * {@link Queryable}.
 */
export type TransactionRunner = <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T>;

const defaultTransactionRunner: TransactionRunner = (fn) =>
  withTransaction((client) => fn(client));

/** SELECT the request's team + status (the start/stop guards need both). */
const REQUEST_TEAM_STATUS_SQL = `SELECT id, team_id, status FROM request WHERE id = $1`;

/** SELECT one member's open timer on a specific request. */
const OPEN_TIMER_FOR_REQUEST_SQL = `SELECT id, request_id, member_id, started_at
   FROM active_timer
  WHERE request_id = $1 AND member_id = $2`;

/** SELECT all of a member's open timers (any request), oldest first. */
const OPEN_TIMERS_FOR_MEMBER_SQL = `SELECT id, request_id, member_id, started_at
   FROM active_timer
  WHERE member_id = $1
  ORDER BY started_at ASC, id ASC`;

/** SELECT all open timers on a request (any member) — auto-stop-and-record. */
const OPEN_TIMERS_FOR_REQUEST_SQL = `SELECT id, request_id, member_id, started_at
   FROM active_timer
  WHERE request_id = $1
  ORDER BY started_at ASC, id ASC`;

/**
 * Insert a time_slice for a stopped timer and delete the active_timer row, on
 * the given transaction, and audit the creation. Shared by the manual stop, the
 * concurrent auto-stop (stopOthers), and the leave-ACTIVE auto-stop so the
 * "record a slice, remove the running timer" behaviour is identical everywhere
 * (R8.6). Returns the recorded slice.
 */
async function recordSliceAndClearTimer(
  timer: ActiveTimerRow,
  endedAt: Date,
  durationMinutes: number,
  audit: AuditWriter,
  tx: Queryable,
): Promise<RecordedSlice> {
  const requestId = Number(timer.request_id);
  const memberId = Number(timer.member_id);
  const started = toDate(timer.started_at);

  const slice = await one<TimeSliceRow>(
    `INSERT INTO time_slice
       (request_id, member_id, started_at, ended_at, duration_minutes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, request_id, member_id, started_at, ended_at, duration_minutes`,
    [requestId, memberId, started, endedAt, durationMinutes],
    tx,
  );
  if (!slice) {
    throw new Error(`Failed to record time_slice for request ${requestId}`);
  }

  // Remove the open timer now that its slice is recorded (R8.6): stopping a
  // timer replaces the open row with an immutable slice.
  await one<{ id: string | number }>(
    `DELETE FROM active_timer WHERE id = $1 RETURNING id`,
    [Number(timer.id)],
    tx,
  );

  // Audit the slice creation (R17): who recorded it and how long.
  await audit.recordChanges(
    { entityType: 'time_slice', entityId: Number(slice.id), changedById: memberId },
    {},
    {
      request_id: requestId,
      member_id: memberId,
      duration_minutes: durationMinutes,
      started_at: started,
      ended_at: endedAt,
    },
    tx,
  );

  return toRecordedSlice(slice);
}

/**
 * Auto-stop-and-record EVERY open timer on a request, up to `endedAt` (design
 * decision 3: a timer is never discarded when a request leaves ACTIVE). Runs on
 * the CALLER'S transaction so it is atomic with the status change that triggered
 * it. The elapsed duration is used (never an edit — this is not a user edit).
 * Returns the recorded slices (empty when no timers were running).
 *
 * Exported for reuse by the support-side status change (task 7.2's store) so
 * leaving ACTIVE and closing out the timers happen in one transaction.
 */
export async function autoStopTimersForRequest(
  requestId: number,
  endedAt: Date,
  tx: Queryable,
  audit: AuditWriter = new AuditWriter(),
): Promise<RecordedSlice[]> {
  const openTimers = await many<ActiveTimerRow>(
    OPEN_TIMERS_FOR_REQUEST_SQL,
    [requestId],
    tx,
  );
  const recorded: RecordedSlice[] = [];
  for (const timer of openTimers) {
    const duration = elapsedMinutes(toDate(timer.started_at), endedAt);
    recorded.push(await recordSliceAndClearTimer(timer, endedAt, duration, audit, tx));
  }
  return recorded;
}

/**
 * Postgres-backed {@link RequestTimerStore}. All SQL is parameterised; each
 * operation and its audit rows share one transaction.
 */
export class DbRequestTimerStore implements RequestTimerStore {
  constructor(
    private readonly audit: AuditWriter = new AuditWriter(),
    private readonly runTransaction: TransactionRunner = defaultTransactionRunner,
  ) {}

  /** Load the request's team + status, or throw {@link TimerRequestNotFoundError}. */
  private async loadRequest(
    requestId: number,
    tx: Queryable,
  ): Promise<{ teamId: number; status: Status }> {
    const row = await one<RequestTeamStatusRow>(
      REQUEST_TEAM_STATUS_SQL,
      [requestId],
      tx,
    );
    if (!row) {
      throw new TimerRequestNotFoundError(requestId);
    }
    if (!isStatus(row.status)) {
      throw new Error(`Unknown stored status ${row.status} on request ${requestId}`);
    }
    return { teamId: Number(row.team_id), status: row.status };
  }

  /** The actor must be a support member of the request's team (R7, R8). */
  private assertSupportMember(
    requestId: number,
    teamId: number,
    actor: TimerActor,
  ): void {
    if (!actor.teamsMemberOf.includes(teamId)) {
      throw new TimerForbiddenError(
        requestId,
        'Only a support member of the request team may record time on it.',
      );
    }
  }

  async startTimer(
    requestId: number,
    input: StartTimerInput,
    actor: TimerActor,
  ): Promise<StartTimerResult> {
    return this.runTransaction(async (tx) => {
      const { teamId, status } = await this.loadRequest(requestId, tx);
      this.assertSupportMember(requestId, teamId, actor);

      // R8.1/R8.2: the "Working on It" action exists only while ACTIVE, and
      // starting a timer must not change the status. Guard here so the button's
      // contract holds on the server too.
      if (status !== 'ACTIVE') {
        throw new TimerNotActiveError(requestId, status);
      }

      // Idempotent re-click: if a timer for this member is already open on THIS
      // request, return it unchanged (the unique index would reject a second).
      const existing = await one<ActiveTimerRow>(
        OPEN_TIMER_FOR_REQUEST_SQL,
        [requestId, actor.userId],
        tx,
      );

      // The member's OTHER open timers (on different requests) drive the
      // concurrent-timer prompt (R8.8). Resolve per `stopOthers` BEFORE opening
      // this one so a stopOthers:true start leaves exactly one running timer.
      const allMine = await many<ActiveTimerRow>(
        OPEN_TIMERS_FOR_MEMBER_SQL,
        [actor.userId],
        tx,
      );
      const others = allMine.filter((t) => Number(t.request_id) !== requestId);

      const stoppedOthers = input.stopOthers === true && others.length > 0;
      if (stoppedOthers) {
        const now = new Date();
        for (const other of others) {
          const duration = elapsedMinutes(toDate(other.started_at), now);
          await recordSliceAndClearTimer(other, now, duration, this.audit, tx);
        }
      }

      const otherOpenTimers = others.map(toOpenTimer);

      if (existing) {
        return {
          timer: toOpenTimer(existing),
          otherOpenTimers,
          stoppedOthers,
        };
      }

      const created = await one<ActiveTimerRow>(
        `INSERT INTO active_timer (request_id, member_id)
         VALUES ($1, $2)
         RETURNING id, request_id, member_id, started_at`,
        [requestId, actor.userId],
        tx,
      );
      if (!created) {
        throw new Error(`Failed to open timer for request ${requestId}`);
      }

      // Audit the timer open (R17): who started timing what.
      await this.audit.recordChanges(
        { entityType: 'active_timer', entityId: Number(created.id), changedById: actor.userId },
        {},
        { request_id: requestId, member_id: actor.userId, started_at: toDate(created.started_at) },
        tx,
      );

      return {
        timer: toOpenTimer(created),
        otherOpenTimers,
        stoppedOthers,
      };
    });
  }

  async stopTimer(
    requestId: number,
    input: StopTimerInput,
    actor: TimerActor,
  ): Promise<RecordedSlice> {
    return this.runTransaction(async (tx) => {
      const { teamId } = await this.loadRequest(requestId, tx);
      this.assertSupportMember(requestId, teamId, actor);

      const timer = await one<ActiveTimerRow>(
        OPEN_TIMER_FOR_REQUEST_SQL,
        [requestId, actor.userId],
        tx,
      );
      if (!timer) {
        throw new NoOpenTimerError(requestId, actor.userId);
      }

      const endedAt = new Date();
      let durationMinutes: number;
      if (input.durationMinutes !== undefined) {
        // R8.5: an EDITED duration MUST be greater than 1 minute.
        if (
          !Number.isFinite(input.durationMinutes) ||
          !Number.isInteger(input.durationMinutes) ||
          input.durationMinutes <= 1
        ) {
          throw errors.timerMinDuration(
            'An edited timer duration must be greater than 1 minute.',
            { durationMinutes: input.durationMinutes },
          );
        }
        durationMinutes = input.durationMinutes;
      } else {
        durationMinutes = elapsedMinutes(toDate(timer.started_at), endedAt);
      }

      return recordSliceAndClearTimer(timer, endedAt, durationMinutes, this.audit, tx);
    });
  }

  async listMyTimers(actor: TimerActor): Promise<OpenTimer[]> {
    const rows = await many<ActiveTimerRow>(OPEN_TIMERS_FOR_MEMBER_SQL, [actor.userId]);
    return rows.map(toOpenTimer);
  }
}
