import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Express } from 'express';
import { ApiError, errorHandler } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/current-user.js';
import {
  createRequestTimerRouter,
  readStartTimerBody,
  readStopTimerBody,
} from './requests-timer.routes.js';
import {
  NoOpenTimerError,
  TimerForbiddenError,
  TimerNotActiveError,
  TimerRequestNotFoundError,
  type OpenTimer,
  type RecordedSlice,
  type RequestTimerStore,
  type StartTimerResult,
} from './requests-timer.store.js';

/**
 * Tests for the time-tracking route layer (design: "Time tracking"; R8). These
 * exercise body parsing (`stopOthers`, `durationMinutes`), the actor identity
 * coming from `req.currentUser` (never the body), the response shapes, and the
 * mapping of store errors to the uniform error envelope. The store is a
 * hand-rolled fake so no database is touched.
 */

function openTimer(overrides: Partial<OpenTimer> = {}): OpenTimer {
  return {
    id: 1,
    requestId: 555,
    memberId: 200,
    startedAt: '2026-02-01T10:00:00.000Z',
    ...overrides,
  };
}

function recordedSlice(overrides: Partial<RecordedSlice> = {}): RecordedSlice {
  return {
    id: 9,
    requestId: 555,
    memberId: 200,
    startedAt: '2026-02-01T10:00:00.000Z',
    endedAt: '2026-02-01T10:30:00.000Z',
    durationMinutes: 30,
    ...overrides,
  };
}

function fakeStore(overrides: Partial<RequestTimerStore>): RequestTimerStore {
  return {
    startTimer: async () => ({
      timer: openTimer(),
      otherOpenTimers: [],
      stoppedOthers: false,
    }),
    stopTimer: async () => recordedSlice(),
    listMyTimers: async () => [],
    ...overrides,
  };
}

function stubUser(id: number, teamsMemberOf: number[] = []): CurrentUser {
  return {
    id,
    username: '22222222',
    displayName: 'Support Member',
    roles: new Set(['USER', 'SUPPORT_MEMBER']),
    teamsLed: [],
    teamsMemberOf,
    isAdmin: false,
    timezone: null,
  };
}

function appWith(store: RequestTimerStore, userId = 200, teams: number[] = [7]): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.currentUser = stubUser(userId, teams);
    next();
  });
  app.use('/api', createRequestTimerRouter(store));
  app.use(errorHandler);
  return app;
}

async function send(
  app: Express,
  method: 'POST' | 'GET',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ── Body parsing ────────────────────────────────────────────────────────────────

describe('readStartTimerBody (R8.8)', () => {
  it('defaults to {} for absent/empty bodies', () => {
    assert.deepEqual(readStartTimerBody(undefined), {});
    assert.deepEqual(readStartTimerBody(null), {});
    assert.deepEqual(readStartTimerBody({}), {});
  });

  it('parses stopOthers:true/false', () => {
    assert.deepEqual(readStartTimerBody({ stopOthers: true }), { stopOthers: true });
    assert.deepEqual(readStartTimerBody({ stopOthers: false }), { stopOthers: false });
  });

  it('rejects a non-boolean stopOthers', () => {
    assert.throws(
      () => readStartTimerBody({ stopOthers: 'yes' }),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });
});

describe('readStopTimerBody (R8.5)', () => {
  it('defaults to {} for absent/empty/null durationMinutes', () => {
    assert.deepEqual(readStopTimerBody(undefined), {});
    assert.deepEqual(readStopTimerBody({}), {});
    assert.deepEqual(readStopTimerBody({ durationMinutes: null }), {});
  });

  it('parses an integer durationMinutes', () => {
    assert.deepEqual(readStopTimerBody({ durationMinutes: 5 }), { durationMinutes: 5 });
  });

  it('rejects a non-integer durationMinutes at the boundary (the >1 rule is the store)', () => {
    assert.throws(
      () => readStopTimerBody({ durationMinutes: 1.5 }),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
    assert.throws(
      () => readStopTimerBody({ durationMinutes: 'x' }),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });
});

// ── POST /api/requests/:id/timer/start ────────────────────────────────────────

describe('POST /api/requests/:id/timer/start (R8.2, R8.8)', () => {
  it('starts a timer using the session actor and returns 201', async () => {
    let capturedActorId = -1;
    const store = fakeStore({
      startTimer: async (id, _input, actor): Promise<StartTimerResult> => {
        capturedActorId = actor.userId;
        return { timer: openTimer({ requestId: id }), otherOpenTimers: [], stoppedOthers: false };
      },
    });
    const { status, body } = await send(appWith(store, 200, [7]), 'POST', '/api/requests/555/timer/start');
    assert.equal(status, 201);
    assert.equal(capturedActorId, 200);
    assert.equal((body['timer'] as Record<string, unknown>)['requestId'], 555);
  });

  it('reports other open timers for the concurrent-timer prompt', async () => {
    const store = fakeStore({
      startTimer: async () => ({
        timer: openTimer(),
        otherOpenTimers: [openTimer({ id: 2, requestId: 900 })],
        stoppedOthers: false,
      }),
    });
    const { status, body } = await send(appWith(store), 'POST', '/api/requests/555/timer/start');
    assert.equal(status, 201);
    const others = body['otherOpenTimers'] as Array<Record<string, unknown>>;
    assert.equal(others.length, 1);
    assert.equal(others[0]!['requestId'], 900);
    assert.equal(body['stoppedOthers'], false);
  });

  it('passes stopOthers:true through to the store', async () => {
    let captured = false;
    const store = fakeStore({
      startTimer: async (_id, input) => {
        captured = input.stopOthers === true;
        return { timer: openTimer(), otherOpenTimers: [], stoppedOthers: true };
      },
    });
    const { status, body } = await send(appWith(store), 'POST', '/api/requests/555/timer/start', {
      stopOthers: true,
    });
    assert.equal(status, 201);
    assert.equal(captured, true);
    assert.equal(body['stoppedOthers'], true);
  });

  it('maps TimerNotActiveError to 409 INVALID_TRANSITION', async () => {
    const store = fakeStore({
      startTimer: async () => {
        throw new TimerNotActiveError(555, 'ASSIGNED');
      },
    });
    const { status, body } = await send(appWith(store), 'POST', '/api/requests/555/timer/start');
    assert.equal(status, 409);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'INVALID_TRANSITION');
  });

  it('maps TimerForbiddenError to 403 FORBIDDEN', async () => {
    const store = fakeStore({
      startTimer: async () => {
        throw new TimerForbiddenError(555);
      },
    });
    const { status, body } = await send(appWith(store), 'POST', '/api/requests/555/timer/start');
    assert.equal(status, 403);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'FORBIDDEN');
  });

  it('maps TimerRequestNotFoundError to 404 NOT_FOUND', async () => {
    const store = fakeStore({
      startTimer: async () => {
        throw new TimerRequestNotFoundError(555);
      },
    });
    const { status, body } = await send(appWith(store), 'POST', '/api/requests/555/timer/start');
    assert.equal(status, 404);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'NOT_FOUND');
  });
});

// ── POST /api/requests/:id/timer/stop ─────────────────────────────────────────

describe('POST /api/requests/:id/timer/stop (R8.4–8.6)', () => {
  it('stops the timer and returns the recorded slice (201)', async () => {
    const store = fakeStore({ stopTimer: async () => recordedSlice({ durationMinutes: 30 }) });
    const { status, body } = await send(appWith(store), 'POST', '/api/requests/555/timer/stop');
    assert.equal(status, 201);
    assert.equal(body['durationMinutes'], 30);
    assert.equal(body['memberId'], 200);
  });

  it('passes an edited durationMinutes through to the store', async () => {
    let captured = -1;
    const store = fakeStore({
      stopTimer: async (_id, input) => {
        captured = input.durationMinutes ?? -1;
        return recordedSlice({ durationMinutes: input.durationMinutes ?? 0 });
      },
    });
    await send(appWith(store), 'POST', '/api/requests/555/timer/stop', { durationMinutes: 5 });
    assert.equal(captured, 5);
  });

  it('re-throws the store TIMER_MIN_DURATION ApiError (400)', async () => {
    const store = fakeStore({
      stopTimer: async () => {
        throw new ApiError(400, 'TIMER_MIN_DURATION', 'must be > 1 minute');
      },
    });
    const { status, body } = await send(appWith(store), 'POST', '/api/requests/555/timer/stop', {
      durationMinutes: 1,
    });
    assert.equal(status, 400);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'TIMER_MIN_DURATION');
  });

  it('maps NoOpenTimerError to 404 NOT_FOUND', async () => {
    const store = fakeStore({
      stopTimer: async () => {
        throw new NoOpenTimerError(555, 200);
      },
    });
    const { status, body } = await send(appWith(store), 'POST', '/api/requests/555/timer/stop');
    assert.equal(status, 404);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'NOT_FOUND');
  });
});

// ── GET /api/requests/:id/timers/mine ─────────────────────────────────────────

describe('GET /api/requests/:id/timers/mine (R8.8)', () => {
  it('splits the actor open timers into this-request and others', async () => {
    const store = fakeStore({
      listMyTimers: async () => [
        openTimer({ id: 1, requestId: 555 }),
        openTimer({ id: 2, requestId: 900 }),
      ],
    });
    const { status, body } = await send(appWith(store), 'GET', '/api/requests/555/timers/mine');
    assert.equal(status, 200);
    const onThis = body['onThisRequest'] as Array<Record<string, unknown>>;
    const others = body['others'] as Array<Record<string, unknown>>;
    assert.equal(onThis.length, 1);
    assert.equal(onThis[0]!['requestId'], 555);
    assert.equal(others.length, 1);
    assert.equal(others[0]!['requestId'], 900);
  });

  it('rejects a malformed id with 400 VALIDATION_FAILED', async () => {
    const store = fakeStore({});
    const { status, body } = await send(appWith(store), 'GET', '/api/requests/nope/timers/mine');
    assert.equal(status, 400);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'VALIDATION_FAILED');
  });
});
