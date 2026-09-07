import { Router, type RequestHandler } from 'express';
import { ApiError, errors } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/index.js';
import {
  DbRequestTimerStore,
  NoOpenTimerError,
  TimerForbiddenError,
  TimerNotActiveError,
  TimerRequestNotFoundError,
  type OpenTimer,
  type RecordedSlice,
  type RequestTimerStore,
  type StartTimerInput,
  type StartTimerResult,
  type StopTimerInput,
  type TimerActor,
} from './requests-timer.store.js';

/**
 * Time-tracking routes (design: "Time tracking"; R8):
 *
 *   POST /api/requests/{id}/timer/start   start a timer (ACTIVE-only; body may
 *                                         resolve the concurrent-timer prompt
 *                                         via `stopOthers:true|false`) — R8.2,
 *                                         R8.8.
 *   POST /api/requests/{id}/timer/stop    stop the member's open timer and
 *                                         record a slice; `{durationMinutes?}`
 *                                         (> 1 when edited) — R8.4–8.6.
 *   GET  /api/requests/{id}/timers/mine   the member's open timer(s) for the
 *                                         prompt logic — R8.8.
 *
 * ── Path & wiring ────────────────────────────────────────────────────────────
 * These sit under `/api/requests/:id/timer(s)/…`, distinct sub-paths from the
 * plain `PATCH /requests/:id` (support update) and the other `/requests/:id/*`
 * user-side routes, so registering them on the same requests router (mounted at
 * `/api`) does not collide.
 *
 * ── Authorisation ────────────────────────────────────────────────────────────
 * Available to any authenticated user; the global `authenticate` middleware
 * upstream guarantees `req.currentUser`. The fine-grained gate (the actor must
 * be a support member of the REQUEST'S team, R8) lives in the store; a denial
 * surfaces here as 403 FORBIDDEN, an unknown id as 404 NOT_FOUND, and a start
 * while not-ACTIVE as 409 INVALID_TRANSITION.
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 * The handlers depend on the narrow {@link RequestTimerStore} so they unit-test
 * with an in-memory fake (no database). Production wiring uses
 * {@link DbRequestTimerStore}.
 */

// ── Public JSON views (camelCase, ISO dates) ───────────────────────────────────

export interface OpenTimerJson {
  readonly id: number;
  readonly requestId: number;
  readonly memberId: number;
  readonly startedAt: string;
}

export function serializeOpenTimer(t: OpenTimer): OpenTimerJson {
  return {
    id: t.id,
    requestId: t.requestId,
    memberId: t.memberId,
    startedAt: t.startedAt,
  };
}

export interface StartTimerResultJson {
  readonly timer: OpenTimerJson;
  readonly otherOpenTimers: readonly OpenTimerJson[];
  readonly stoppedOthers: boolean;
}

export function serializeStartResult(r: StartTimerResult): StartTimerResultJson {
  return {
    timer: serializeOpenTimer(r.timer),
    otherOpenTimers: r.otherOpenTimers.map(serializeOpenTimer),
    stoppedOthers: r.stoppedOthers,
  };
}

export interface RecordedSliceJson {
  readonly id: number;
  readonly requestId: number;
  readonly memberId: number;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMinutes: number;
}

export function serializeRecordedSlice(s: RecordedSlice): RecordedSliceJson {
  return {
    id: s.id,
    requestId: s.requestId,
    memberId: s.memberId,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    durationMinutes: s.durationMinutes,
  };
}

// ── Param / body parsing ───────────────────────────────────────────────────────

/** Parse a positive-integer id from a value, or `null` when malformed. */
function toPositiveInt(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0) {
      return n;
    }
  }
  return null;
}

/** Read and validate the `:id` path param, or throw VALIDATION_FAILED. */
function requestIdParam(req: { params: Record<string, unknown> }): number {
  const id = toPositiveInt(req.params['id']);
  if (id === null) {
    throw errors.validationFailed('A valid request id is required.', { field: 'id' });
  }
  return id;
}

/** Read the authenticated current user (authenticate guarantees it upstream). */
function currentUser(req: { currentUser?: CurrentUser }): CurrentUser {
  const user = req.currentUser;
  if (!user) {
    // Defensive: authenticate runs upstream, so this is unreachable.
    throw ApiError.of('FORBIDDEN', 'Authentication required', undefined, 401);
  }
  return user;
}

/** Build the {@link TimerActor} the store consumes from the current user. */
function toActor(user: CurrentUser): TimerActor {
  return { userId: user.id, teamsMemberOf: user.teamsMemberOf };
}

/**
 * Parse the timer-start body (R8.8): optional `stopOthers` boolean resolving the
 * concurrent-timer prompt. An absent/empty body means "leave others running".
 */
export function readStartTimerBody(body: unknown): StartTimerInput {
  if (body === undefined || body === null || body === '') {
    return {};
  }
  if (typeof body !== 'object') {
    throw errors.validationFailed('A JSON body is required.', { field: 'body' });
  }
  const record = body as Record<string, unknown>;
  if (!('stopOthers' in record)) {
    return {};
  }
  const raw = record['stopOthers'];
  if (typeof raw !== 'boolean') {
    throw errors.validationFailed('stopOthers must be a boolean.', {
      field: 'stopOthers',
    });
  }
  return { stopOthers: raw };
}

/**
 * Parse the timer-stop body (R8.5): optional `durationMinutes`. When present it
 * must be an integer; the ">1 minute" rule is enforced in the store so the
 * TIMER_MIN_DURATION code is emitted from one place. An absent body records the
 * elapsed duration.
 */
export function readStopTimerBody(body: unknown): StopTimerInput {
  if (body === undefined || body === null || body === '') {
    return {};
  }
  if (typeof body !== 'object') {
    throw errors.validationFailed('A JSON body is required.', { field: 'body' });
  }
  const record = body as Record<string, unknown>;
  if (!('durationMinutes' in record) || record['durationMinutes'] === null) {
    return {};
  }
  const raw = record['durationMinutes'];
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw errors.validationFailed('durationMinutes must be an integer.', {
      field: 'durationMinutes',
    });
  }
  return { durationMinutes: raw };
}

/**
 * Map a store error to the uniform envelope. `TimerRequestNotFoundError` /
 * `NoOpenTimerError` → 404, `TimerForbiddenError` → 403 FORBIDDEN,
 * `TimerNotActiveError` → 409 INVALID_TRANSITION. Anything else (incl. the
 * TIMER_MIN_DURATION ApiError from the store) is re-thrown unchanged.
 */
function mapStoreError(err: unknown): never {
  if (err instanceof TimerRequestNotFoundError) {
    throw ApiError.of('NOT_FOUND', 'Request not found.', { requestId: err.requestId });
  }
  if (err instanceof NoOpenTimerError) {
    throw ApiError.of('NOT_FOUND', 'No open timer to stop.', {
      requestId: err.requestId,
    });
  }
  if (err instanceof TimerForbiddenError) {
    throw errors.forbidden(err.message, { requestId: err.requestId });
  }
  if (err instanceof TimerNotActiveError) {
    throw errors.invalidTransition(err.message, {
      requestId: err.requestId,
      status: err.status,
    });
  }
  throw err;
}

// ── Handlers ────────────────────────────────────────────────────────────────────

/** POST /requests/:id/timer/start — start a timer (R8.2, R8.8). */
export function makeStartTimerHandler(store: RequestTimerStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const id = requestIdParam(req as never);
      const input = readStartTimerBody(req.body);
      const actor = toActor(currentUser(req));
      try {
        const result = await store.startTimer(id, input, actor);
        res.status(201).json(serializeStartResult(result));
      } catch (err) {
        mapStoreError(err);
      }
    })().catch(next);
  };
}

/** POST /requests/:id/timer/stop — stop timer + record slice (R8.4–8.6). */
export function makeStopTimerHandler(store: RequestTimerStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const id = requestIdParam(req as never);
      const input = readStopTimerBody(req.body);
      const actor = toActor(currentUser(req));
      try {
        const slice = await store.stopTimer(id, input, actor);
        res.status(201).json(serializeRecordedSlice(slice));
      } catch (err) {
        mapStoreError(err);
      }
    })().catch(next);
  };
}

/** GET /requests/:id/timers/mine — the member's open timer(s) (R8.8). */
export function makeListMyTimersHandler(store: RequestTimerStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const id = requestIdParam(req as never);
      const actor = toActor(currentUser(req));
      const all = await store.listMyTimers(actor);
      // Report this request's open timer (if any) plus the member's other open
      // timers, so the UI can drive both the button state and the prompt (R8.8).
      const onThisRequest = all.filter((t) => t.requestId === id);
      const others = all.filter((t) => t.requestId !== id);
      res.status(200).json({
        onThisRequest: onThisRequest.map(serializeOpenTimer),
        others: others.map(serializeOpenTimer),
      });
    })().catch(next);
  };
}

/**
 * Register the timer routes on a router (mounted at `/api`), so the full paths
 * are `POST /api/requests/:id/timer/start`, `POST /api/requests/:id/timer/stop`,
 * and `GET /api/requests/:id/timers/mine`. The store is injected for
 * testability; production uses {@link DbRequestTimerStore}.
 */
export function registerRequestTimerRoutes(
  router: Router,
  store: RequestTimerStore,
): Router {
  router.post('/requests/:id/timer/start', makeStartTimerHandler(store));
  router.post('/requests/:id/timer/stop', makeStopTimerHandler(store));
  router.get('/requests/:id/timers/mine', makeListMyTimersHandler(store));
  return router;
}

/** A standalone router (used by tests and for isolated wiring). */
export function createRequestTimerRouter(store: RequestTimerStore): Router {
  return registerRequestTimerRoutes(Router(), store);
}
