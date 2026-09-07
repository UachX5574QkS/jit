import type { ErrorRequestHandler, RequestHandler } from 'express';

/**
 * The uniform error model (design: "Error model", R3, R5.4, R8.5, R9.7, R20).
 *
 * ── One envelope for every failure ───────────────────────────────────────────
 * Every error response the API produces — from any handler, guard, or the
 * fallthrough handlers below — is serialised to the same shape:
 *
 *     { "error": { "code": string, "message": string, "details"?: unknown } }
 *
 * so the frontend HTTP interceptor (task 9.2) can read one shape regardless of
 * which endpoint failed. Domain code never invents its own response body; it
 * throws an {@link ApiError} (directly or via one of the {@link errors}
 * factories) and the shared {@link errorHandler} does the serialisation.
 *
 * ── The code catalogue ───────────────────────────────────────────────────────
 * This module is the single source of truth for the set of error codes and each
 * code's canonical HTTP status ({@link ERROR_CODES} / {@link CODE_STATUS}). The
 * cross-cutting services introduced earlier in task 3 already flow their codes
 * through the {@link ApiError} envelope — the status machine emits
 * `INVALID_TRANSITION` (task 3.5), field validation emits `MANDATORY_FIELD` /
 * `VALIDATION_FAILED` (task 3.7), and the authorisation middleware emits
 * `FORBIDDEN` (task 3.3). This task consolidates those, adds the two codes not
 * yet used by a service — `CONFLICT_OPEN_REQUESTS` (reference-data guards,
 * R20.2–20.3, task 5) and `TIMER_MIN_DURATION` (timer duration edit, R8.5,
 * task 7.4) — and pins each code to a canonical status so callers do not
 * hard-code numbers.
 *
 * ── Canonical statuses (and why) ─────────────────────────────────────────────
 *   INVALID_TRANSITION      409  illegal status-machine move (R9.7) — a conflict
 *                                with the request's current state.
 *   MANDATORY_FIELD         409  a required value was left blank (R3.6, R5.4) —
 *                                kept at 409 to match the existing validation
 *                                guards (task 3.7), which distinguish a missing
 *                                mandatory value from a plain format error.
 *   VALIDATION_FAILED       400  a value failed a type/format/option check (R3).
 *   FORBIDDEN               403  authenticated but not permitted (R1.8). The
 *                                authenticate step still uses 401 for "not
 *                                authenticated" via the constructor directly —
 *                                see {@link forbidden} — so 403 is only the
 *                                default for the authorised-but-denied case.
 *   CONFLICT_OPEN_REQUESTS  409  a reference-data change is blocked by non-closed
 *                                requests: close a team / remove a member /
 *                                retire while open requests exist (R20.2–20.3) —
 *                                a state conflict, hence 409.
 *   TIMER_MIN_DURATION      400  an edited timer duration was not greater than
 *                                one minute (R8.5). This is bad INPUT on the
 *                                stop-timer request, not a conflict with stored
 *                                state, so it is a 400 — consistent with
 *                                VALIDATION_FAILED rather than the 409 conflicts.
 *   NOT_FOUND               404  no matching route/resource (fallthrough).
 *   INTERNAL_ERROR          500  an unexpected/unhandled error — always mapped to
 *                                a safe generic envelope so internals never leak.
 */

/** The full catalogue of error codes the API can return, canonical status per code. */
export const CODE_STATUS = {
  INVALID_TRANSITION: 409,
  MANDATORY_FIELD: 409,
  VALIDATION_FAILED: 400,
  FORBIDDEN: 403,
  CONFLICT_OPEN_REQUESTS: 409,
  TIMER_MIN_DURATION: 400,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
} as const satisfies Record<string, number>;

/** A tuple of every known error code (source of truth for {@link ErrorCode}). */
export const ERROR_CODES = Object.keys(CODE_STATUS) as ReadonlyArray<ErrorCode>;

/** The union of every error code the API can return. */
export type ErrorCode = keyof typeof CODE_STATUS;

/** True iff `value` is one of the known error codes. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && value in CODE_STATUS;
}

/** The canonical HTTP status for a known error code (R3, R8.5, R9.7, R20). */
export function statusForCode(code: ErrorCode): number {
  return CODE_STATUS[code];
}

/**
 * A domain error carrying its HTTP status, machine-readable {@link ErrorCode},
 * a human message, and optional structured `details`. Thrown by handlers/guards
 * and serialised by {@link errorHandler} into the uniform envelope.
 *
 * The constructor keeps its original signature — `(status, code, message,
 * details?)` — so every existing call site (tasks 3.3/3.5/3.7) is unchanged and
 * may still pass a bespoke status (e.g. the authenticate step's 401 FORBIDDEN).
 * The {@link errors} factories are the preferred way to construct one from the
 * canonical status without repeating numbers.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /**
   * Build an {@link ApiError} from a known {@link ErrorCode}, using that code's
   * canonical status ({@link CODE_STATUS}) unless a `status` override is given.
   * Prefer the named {@link errors} factories for readability.
   */
  static of(
    code: ErrorCode,
    message: string,
    details?: unknown,
    status: number = CODE_STATUS[code],
  ): ApiError {
    return new ApiError(status, code, message, details);
  }
}

/**
 * Convenience factories, one per domain code, each stamping the canonical
 * status so call sites read as intent rather than status numbers. Backwards
 * compatible: they produce the same {@link ApiError} the existing guards throw
 * by hand, so adopting them is optional and incremental.
 */
export const errors = {
  /** Illegal status-machine transition (409, R9.7). */
  invalidTransition(message: string, details?: unknown): ApiError {
    return ApiError.of('INVALID_TRANSITION', message, details);
  },
  /** A required field was left blank (409, R3.6/R5.4). */
  mandatoryField(message: string, details?: unknown): ApiError {
    return ApiError.of('MANDATORY_FIELD', message, details);
  },
  /** A value failed a type/format/option check (400, R3). */
  validationFailed(message: string, details?: unknown): ApiError {
    return ApiError.of('VALIDATION_FAILED', message, details);
  },
  /**
   * Authenticated but not permitted (403, R1.8). Pass `status: 401` for the
   * "not authenticated" case so the authenticate step keeps its behaviour.
   */
  forbidden(message: string, details?: unknown, status: number = CODE_STATUS.FORBIDDEN): ApiError {
    return ApiError.of('FORBIDDEN', message, details, status);
  },
  /** A reference-data change is blocked by non-closed requests (409, R20.2–20.3). */
  conflictOpenRequests(message: string, details?: unknown): ApiError {
    return ApiError.of('CONFLICT_OPEN_REQUESTS', message, details);
  },
  /** An edited timer duration was not greater than one minute (400, R8.5). */
  timerMinDuration(message: string, details?: unknown): ApiError {
    return ApiError.of('TIMER_MIN_DURATION', message, details);
  },
} as const;

/** 404 for any unmatched route, in the uniform error envelope. */
export const notFoundHandler: RequestHandler = (_req, res) => {
  res.status(CODE_STATUS.NOT_FOUND).json({
    error: { code: 'NOT_FOUND', message: 'Resource not found' },
  });
};

/**
 * Terminal error handler producing the uniform error envelope.
 *
 * An {@link ApiError} is serialised to its own status/code/message (and
 * `details` when present — omitted otherwise so the envelope stays clean). Any
 * other thrown value is an unexpected/unhandled error: it is logged server-side
 * and mapped to a safe generic `500 INTERNAL_ERROR` so no internal detail
 * (stack, message, driver text) ever leaks to the client.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof ApiError) {
    const body: { code: string; message: string; details?: unknown } = {
      code: err.code,
      message: err.message,
    };
    if (err.details !== undefined) {
      body.details = err.details;
    }
    res.status(err.status).json({ error: body });
    return;
  }

  // eslint-disable-next-line no-console
  console.error('Unhandled error:', err);
  res.status(CODE_STATUS.INTERNAL_ERROR).json({
    error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
  });
};
