import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  ApiError,
  CODE_STATUS,
  ERROR_CODES,
  type ErrorCode,
  isErrorCode,
  statusForCode,
  errors,
  errorHandler,
  notFoundHandler,
} from './errors.js';

/**
 * DB-free unit tests for the uniform error model (design: "Error model", R3,
 * R5.4, R8.5, R9.7, R20), matching the node:test + node:assert/strict,
 * injectable/pure style of the other cross-cutting modules. They assert the
 * code catalogue and canonical statuses, the {@link ApiError} shape and
 * factories, the `{ error: { code, message, details? } }` envelope for known
 * errors, details passthrough/omission, and the unknown-error → safe 500 path.
 */

/** Run the terminal error handler with `err` and return the captured status/body. */
function handle(err: unknown): { status: number | undefined; body: any } {
  const captured: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(body: unknown) {
      captured.body = body;
      return this;
    },
  } as unknown as Response;
  errorHandler(err, {} as Request, res, () => {});
  return { status: captured.statusCode, body: captured.body };
}

describe('CODE_STATUS catalogue (R3, R8.5, R9.7, R20)', () => {
  it('defines every domain code with its canonical status', () => {
    assert.equal(CODE_STATUS.INVALID_TRANSITION, 409);
    assert.equal(CODE_STATUS.MANDATORY_FIELD, 409);
    assert.equal(CODE_STATUS.VALIDATION_FAILED, 400);
    assert.equal(CODE_STATUS.FORBIDDEN, 403);
    assert.equal(CODE_STATUS.CONFLICT_OPEN_REQUESTS, 409);
    assert.equal(CODE_STATUS.TIMER_MIN_DURATION, 400);
  });

  it('includes the infrastructure fallthrough codes', () => {
    assert.equal(CODE_STATUS.NOT_FOUND, 404);
    assert.equal(CODE_STATUS.INTERNAL_ERROR, 500);
  });

  it('exposes ERROR_CODES matching the CODE_STATUS keys', () => {
    assert.deepEqual([...ERROR_CODES].sort(), Object.keys(CODE_STATUS).sort());
  });

  it('statusForCode returns the canonical status for every code', () => {
    for (const code of ERROR_CODES) {
      assert.equal(statusForCode(code), CODE_STATUS[code], code);
    }
  });
});

describe('isErrorCode', () => {
  it('accepts every known code', () => {
    for (const code of ERROR_CODES) {
      assert.equal(isErrorCode(code), true, code);
    }
  });

  it('rejects unknown strings and non-strings', () => {
    assert.equal(isErrorCode('NOPE'), false);
    assert.equal(isErrorCode('forbidden'), false); // case-sensitive
    assert.equal(isErrorCode(''), false);
    assert.equal(isErrorCode(null), false);
    assert.equal(isErrorCode(undefined), false);
    assert.equal(isErrorCode(409), false);
  });
});

describe('ApiError shape', () => {
  it('is an Error carrying status/code/message/details', () => {
    const err = new ApiError(409, 'CONFLICT_OPEN_REQUESTS', 'nope', { teamId: 7 });
    assert.ok(err instanceof Error);
    assert.ok(err instanceof ApiError);
    assert.equal(err.name, 'ApiError');
    assert.equal(err.status, 409);
    assert.equal(err.code, 'CONFLICT_OPEN_REQUESTS');
    assert.equal(err.message, 'nope');
    assert.deepEqual(err.details, { teamId: 7 });
  });

  it('leaves details undefined when omitted', () => {
    const err = new ApiError(403, 'FORBIDDEN', 'denied');
    assert.equal(err.details, undefined);
  });

  it('ApiError.of stamps the canonical status for a code', () => {
    const err = ApiError.of('TIMER_MIN_DURATION', 'too short');
    assert.equal(err.status, 400);
    assert.equal(err.code, 'TIMER_MIN_DURATION');
  });

  it('ApiError.of honours a status override', () => {
    const err = ApiError.of('FORBIDDEN', 'no session', undefined, 401);
    assert.equal(err.status, 401);
    assert.equal(err.code, 'FORBIDDEN');
  });
});

describe('errors factories map to canonical status + code', () => {
  const cases: ReadonlyArray<[() => ApiError, ErrorCode, number]> = [
    [() => errors.invalidTransition('x'), 'INVALID_TRANSITION', 409],
    [() => errors.mandatoryField('x'), 'MANDATORY_FIELD', 409],
    [() => errors.validationFailed('x'), 'VALIDATION_FAILED', 400],
    [() => errors.forbidden('x'), 'FORBIDDEN', 403],
    [() => errors.conflictOpenRequests('x'), 'CONFLICT_OPEN_REQUESTS', 409],
    [() => errors.timerMinDuration('x'), 'TIMER_MIN_DURATION', 400],
  ];

  for (const [make, code, status] of cases) {
    it(`${code} → ${status}`, () => {
      const err = make();
      assert.equal(err.code, code);
      assert.equal(err.status, status);
    });
  }

  it('forbidden accepts a 401 status for the unauthenticated case', () => {
    const err = errors.forbidden('Authentication required', undefined, 401);
    assert.equal(err.status, 401);
    assert.equal(err.code, 'FORBIDDEN');
  });

  it('factories pass details through', () => {
    const err = errors.conflictOpenRequests('blocked', { openRequests: 3 });
    assert.deepEqual(err.details, { openRequests: 3 });
  });
});

describe('errorHandler — uniform envelope for ApiError', () => {
  it('serialises status/code/message and includes details when present', () => {
    const { status, body } = handle(
      new ApiError(409, 'INVALID_TRANSITION', 'bad move', { from: 'NEW', to: 'COMPLETE' }),
    );
    assert.equal(status, 409);
    assert.deepEqual(body, {
      error: {
        code: 'INVALID_TRANSITION',
        message: 'bad move',
        details: { from: 'NEW', to: 'COMPLETE' },
      },
    });
  });

  it('omits the details key entirely when there are none', () => {
    const { status, body } = handle(new ApiError(403, 'FORBIDDEN', 'denied'));
    assert.equal(status, 403);
    assert.deepEqual(body, { error: { code: 'FORBIDDEN', message: 'denied' } });
    assert.equal('details' in (body as any).error, false);
  });

  it('maps each factory error to its canonical status in the envelope', () => {
    for (const make of [
      () => errors.mandatoryField('required'),
      () => errors.validationFailed('bad'),
      () => errors.timerMinDuration('too short'),
      () => errors.conflictOpenRequests('open requests'),
    ]) {
      const err = make();
      const { status, body } = handle(err);
      assert.equal(status, err.status);
      assert.equal((body as any).error.code, err.code);
    }
  });
});

describe('errorHandler — unknown/unexpected errors → safe 500', () => {
  it('maps a plain Error to a generic 500 INTERNAL_ERROR without leaking internals', () => {
    const { status, body } = handle(new Error('database password is hunter2'));
    assert.equal(status, 500);
    assert.deepEqual(body, {
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
    // The original message must not appear anywhere in the response.
    assert.equal(JSON.stringify(body).includes('hunter2'), false);
  });

  it('maps non-Error throwables (string) to the same safe 500', () => {
    const { status, body } = handle('boom');
    assert.equal(status, 500);
    assert.equal((body as any).error.code, 'INTERNAL_ERROR');
  });
});

describe('notFoundHandler', () => {
  it('produces a 404 NOT_FOUND uniform envelope', () => {
    const captured: { statusCode?: number; body?: unknown } = {};
    const res = {
      status(code: number) {
        captured.statusCode = code;
        return this;
      },
      json(body: unknown) {
        captured.body = body;
        return this;
      },
    } as unknown as Response;
    notFoundHandler({} as Request, res, () => {});
    assert.equal(captured.statusCode, 404);
    assert.deepEqual(captured.body, {
      error: { code: 'NOT_FOUND', message: 'Resource not found' },
    });
  });
});
