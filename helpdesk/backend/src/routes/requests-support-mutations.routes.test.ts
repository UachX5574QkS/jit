import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Express } from 'express';
import { ApiError, errorHandler } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/current-user.js';
import {
  createRequestSupportMutationsRouter,
  readUpdateRequestBody,
  serializeRequestSummary,
} from './requests-support-mutations.routes.js';
import {
  AssigneeNotInTeamError,
  RequestForbiddenError,
  RequestNotFoundError,
  UnknownFieldError,
  type RequestSummary,
  type RequestSupportMutationsStore,
  type UpdateRequestInput,
} from './requests-support-mutations.store.js';

/**
 * Tests for the support-side mutation route layer (design: "Support side" —
 * `PATCH /api/requests/{id}`, R7.1, R7.2, R9). These exercise body parsing, the
 * actor identity coming from `req.currentUser` (never the body), the response
 * shape, and the mapping of store errors to the uniform error envelope. The
 * store is a hand-rolled fake so no database is touched — matching the
 * injectable-store route style.
 */

function summaryRow(overrides: Partial<RequestSummary> = {}): RequestSummary {
  return {
    id: 555,
    taskReference: 'REQ-ABC-000001',
    taskVersionId: 900,
    title: 'Broken printer',
    raisedById: 100,
    teamId: 7,
    assignedMemberId: null,
    status: 'ASSIGNED',
    jiraNumber: null,
    estimatedStartDate: null,
    actualStartDate: null,
    createdAt: '2026-02-01T09:00:00.000Z',
    updatedAt: '2026-02-01T10:00:00.000Z',
    ...overrides,
  };
}

function fakeStore(
  updateRequest: RequestSupportMutationsStore['updateRequest'],
): RequestSupportMutationsStore {
  return { updateRequest };
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

function appWith(
  store: RequestSupportMutationsStore,
  userId = 200,
  teams: number[] = [7],
): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.currentUser = stubUser(userId, teams);
    next();
  });
  app.use('/api', createRequestSupportMutationsRouter(store));
  app.use(errorHandler);
  return app;
}

async function send(
  app: Express,
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
      method: 'PATCH',
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

describe('readUpdateRequestBody (R7.1, R7.2, R9)', () => {
  it('parses field values, jira, dates, status, and assignment', () => {
    const input = readUpdateRequestBody({
      fieldValues: [{ taskFieldId: 1, value: 'x' }],
      jiraNumber: '  J-9  ',
      estimatedStartDate: '2026-03-01T09:00:00.000Z',
      actualStartDate: '2026-03-02T09:00:00.000Z',
      status: 'ACTIVE',
      assignedMemberId: 250,
    });
    assert.deepEqual(input.fieldValues, [{ taskFieldId: 1, value: 'x' }]);
    assert.equal(input.jiraNumber, 'J-9');
    assert.equal(input.estimatedStartDate, '2026-03-01T09:00:00.000Z');
    assert.equal(input.actualStartDate, '2026-03-02T09:00:00.000Z');
    assert.equal(input.status, 'ACTIVE');
    assert.equal(input.assignedMemberId, 250);
  });

  it('distinguishes absent (undefined) from explicit null for assignment (unassign)', () => {
    const absent = readUpdateRequestBody({ status: 'ACTIVE' });
    assert.equal(absent.assignedMemberId, undefined);
    const unassign = readUpdateRequestBody({ assignedMemberId: null });
    assert.equal(unassign.assignedMemberId, null);
  });

  it('rejects an unknown status value with VALIDATION_FAILED', () => {
    assert.throws(
      () => readUpdateRequestBody({ status: 'DONE' }),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });

  it('rejects a non-integer assignedMemberId (other than null)', () => {
    assert.throws(
      () => readUpdateRequestBody({ assignedMemberId: 'abc' }),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });

  it('rejects an empty patch', () => {
    assert.throws(
      () => readUpdateRequestBody({}),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });

  it('rejects duplicate taskFieldId entries', () => {
    assert.throws(() =>
      readUpdateRequestBody({
        fieldValues: [
          { taskFieldId: 1, value: 'a' },
          { taskFieldId: 1, value: 'b' },
        ],
      }),
    );
  });
});

describe('serializeRequestSummary', () => {
  it('passes camelCase/ISO fields through unchanged', () => {
    const json = serializeRequestSummary(summaryRow({ assignedMemberId: 250, status: 'ACTIVE' }));
    assert.equal(json.assignedMemberId, 250);
    assert.equal(json.status, 'ACTIVE');
    assert.equal(json.createdAt, '2026-02-01T09:00:00.000Z');
  });
});

// ── PATCH /api/requests/:id ──────────────────────────────────────────────────

describe('PATCH /api/requests/:id (R7.1, R7.2, R9)', () => {
  it('updates using the actor from the session and returns 200', async () => {
    let capturedActorId = -1;
    let capturedInput: UpdateRequestInput | null = null;
    const store = fakeStore(async (id, input, actor) => {
      capturedActorId = actor.userId;
      capturedInput = input;
      return summaryRow({ id, status: 'ACTIVE' });
    });
    const { status, body } = await send(appWith(store, 200, [7]), '/api/requests/555', {
      status: 'ACTIVE',
    });
    assert.equal(status, 200);
    assert.equal(body['status'], 'ACTIVE');
    assert.equal(capturedActorId, 200);
    assert.ok(capturedInput);
  });

  it('passes the session team memberships to the store as the actor', async () => {
    let capturedTeams: readonly number[] = [];
    const store = fakeStore(async (id, _input, actor) => {
      capturedTeams = actor.teamsMemberOf;
      return summaryRow({ id });
    });
    await send(appWith(store, 200, [7, 8]), '/api/requests/555', { jiraNumber: 'J-1' });
    assert.deepEqual([...capturedTeams], [7, 8]);
  });

  it('maps RequestForbiddenError to 403 FORBIDDEN', async () => {
    const store = fakeStore(async () => {
      throw new RequestForbiddenError(555, 'nope');
    });
    const { status, body } = await send(appWith(store), '/api/requests/555', { jiraNumber: 'J-1' });
    assert.equal(status, 403);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'FORBIDDEN');
  });

  it('maps RequestNotFoundError to 404 NOT_FOUND', async () => {
    const store = fakeStore(async () => {
      throw new RequestNotFoundError(555);
    });
    const { status, body } = await send(appWith(store), '/api/requests/555', { jiraNumber: 'J-1' });
    assert.equal(status, 404);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'NOT_FOUND');
  });

  it('maps AssigneeNotInTeamError to 400 VALIDATION_FAILED', async () => {
    const store = fakeStore(async () => {
      throw new AssigneeNotInTeamError(555, 999, 7);
    });
    const { status, body } = await send(appWith(store), '/api/requests/555', {
      assignedMemberId: 999,
    });
    assert.equal(status, 400);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'VALIDATION_FAILED');
  });

  it('maps UnknownFieldError to 400 VALIDATION_FAILED', async () => {
    const store = fakeStore(async () => {
      throw new UnknownFieldError(999);
    });
    const { status, body } = await send(appWith(store), '/api/requests/555', {
      fieldValues: [{ taskFieldId: 999, value: 'x' }],
    });
    assert.equal(status, 400);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'VALIDATION_FAILED');
  });

  it('re-throws the state machine INVALID_TRANSITION ApiError (409)', async () => {
    const store = fakeStore(async () => {
      throw new ApiError(409, 'INVALID_TRANSITION', 'Cannot move a request from NEW to COMPLETE', {
        from: 'NEW',
        to: 'COMPLETE',
      });
    });
    const { status, body } = await send(appWith(store), '/api/requests/555', { status: 'COMPLETE' });
    assert.equal(status, 409);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'INVALID_TRANSITION');
  });

  it('rejects a malformed id with 400 VALIDATION_FAILED', async () => {
    const store = fakeStore(async () => summaryRow());
    const { status, body } = await send(appWith(store), '/api/requests/not-a-number', {
      jiraNumber: 'J-1',
    });
    assert.equal(status, 400);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'VALIDATION_FAILED');
  });
});
