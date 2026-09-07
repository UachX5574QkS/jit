/**
 * The frontend view of the backend's uniform error model (design: "Error
 * model", R3, R5.4, R8.5, R9.7, R20). The backend serialises every failure to
 *
 *     { "error": { "code": string, "message": string, "details"?: unknown } }
 *
 * and the {@link errorInterceptor} maps any failed HTTP response into an
 * {@link ApiError} carrying that code/message/details plus the HTTP status. So
 * feature code catches ONE error type regardless of which endpoint failed and
 * can branch on the machine-readable {@link ApiErrorCode}.
 */

/**
 * The catalogue of error codes the backend can return (single source of truth
 * mirrored from `backend/src/middleware/errors.ts`):
 *
 *   • INVALID_TRANSITION     illegal status-machine move (R9.7).
 *   • MANDATORY_FIELD        a required value was left blank (R3.6, R5.4).
 *   • VALIDATION_FAILED      a value failed a type/format/option check (R3).
 *   • FORBIDDEN              authenticated but not permitted, or not
 *                            authenticated (401) (R1.8).
 *   • CONFLICT_OPEN_REQUESTS a reference-data change is blocked by non-closed
 *                            requests (R20.2–20.3).
 *   • TIMER_MIN_DURATION     an edited timer duration was not > 1 minute (R8.5).
 *   • NOT_FOUND              no matching route/resource.
 *   • INTERNAL_ERROR         an unexpected server error.
 *   • NETWORK_ERROR          the request never reached the server (offline,
 *                            CORS, connection refused) — frontend-only code so
 *                            callers can distinguish "no response" from a
 *                            server-produced envelope.
 */
export type ApiErrorCode =
  | 'INVALID_TRANSITION'
  | 'MANDATORY_FIELD'
  | 'VALIDATION_FAILED'
  | 'FORBIDDEN'
  | 'CONFLICT_OPEN_REQUESTS'
  | 'TIMER_MIN_DURATION'
  | 'NOT_FOUND'
  | 'INTERNAL_ERROR'
  | 'NETWORK_ERROR';

/** The known backend error codes (excludes the frontend-only `NETWORK_ERROR`). */
const BACKEND_CODES: readonly ApiErrorCode[] = [
  'INVALID_TRANSITION',
  'MANDATORY_FIELD',
  'VALIDATION_FAILED',
  'FORBIDDEN',
  'CONFLICT_OPEN_REQUESTS',
  'TIMER_MIN_DURATION',
  'NOT_FOUND',
  'INTERNAL_ERROR',
];

/** True iff `value` is a code the backend is documented to return. */
export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === 'string' && (BACKEND_CODES as readonly string[]).includes(value);
}

/** The `{ error: { code, message, details? } }` envelope shape. */
interface ErrorEnvelope {
  error: { code?: unknown; message?: unknown; details?: unknown };
}

function isErrorEnvelope(body: unknown): body is ErrorEnvelope {
  return (
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    typeof (body as { error: unknown }).error === 'object' &&
    (body as { error: unknown }).error !== null
  );
}

/**
 * The uniform frontend error. Thrown (via an rxjs error) by the
 * {@link errorInterceptor} so every consumer branches on the same type.
 */
export class ApiError extends Error {
  /** Machine-readable code (mapped from the envelope, or a fallback). */
  readonly code: ApiErrorCode;
  /** HTTP status (0 when the request never reached the server). */
  readonly status: number;
  /** Optional structured details echoed from the backend. */
  readonly details?: unknown;

  constructor(code: ApiErrorCode, message: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /**
   * Map a failed HTTP response into an {@link ApiError}.
   *
   * A status of 0 means the request never reached the server (offline / CORS /
   * connection refused) → `NETWORK_ERROR`. Otherwise the body is inspected for
   * the uniform `{ error: { code, message } }` envelope: a recognised code is
   * used verbatim; an unrecognised or missing envelope falls back to a status-
   * derived code (`NOT_FOUND` for 404, `FORBIDDEN` for 401/403, else
   * `INTERNAL_ERROR`) so callers always receive a usable code.
   */
  static fromHttp(status: number, body: unknown): ApiError {
    if (status === 0) {
      return new ApiError('NETWORK_ERROR', 'Unable to reach the server.', 0);
    }

    if (isErrorEnvelope(body)) {
      const { code, message, details } = body.error;
      if (isApiErrorCode(code)) {
        const text =
          typeof message === 'string' && message.trim() !== ''
            ? message
            : defaultMessageForCode(code);
        return new ApiError(code, text, status, details);
      }
    }

    const fallback = fallbackCodeForStatus(status);
    return new ApiError(fallback, defaultMessageForCode(fallback), status, undefined);
  }
}

/** Derive a sensible code when the body is not a recognised envelope. */
function fallbackCodeForStatus(status: number): ApiErrorCode {
  if (status === 404) return 'NOT_FOUND';
  if (status === 401 || status === 403) return 'FORBIDDEN';
  if (status === 400 || status === 422) return 'VALIDATION_FAILED';
  if (status === 409) return 'INVALID_TRANSITION';
  return 'INTERNAL_ERROR';
}

/** A user-facing default message per code, used when the server sends none. */
export function defaultMessageForCode(code: ApiErrorCode): string {
  switch (code) {
    case 'INVALID_TRANSITION':
      return 'That status change is not allowed.';
    case 'MANDATORY_FIELD':
      return 'A required field is missing.';
    case 'VALIDATION_FAILED':
      return 'Some values are invalid.';
    case 'FORBIDDEN':
      return 'You are not permitted to do that.';
    case 'CONFLICT_OPEN_REQUESTS':
      return 'This is blocked by open requests.';
    case 'TIMER_MIN_DURATION':
      return 'The recorded time must be greater than one minute.';
    case 'NOT_FOUND':
      return 'The requested resource was not found.';
    case 'NETWORK_ERROR':
      return 'Unable to reach the server.';
    case 'INTERNAL_ERROR':
    default:
      return 'An unexpected error occurred.';
  }
}
