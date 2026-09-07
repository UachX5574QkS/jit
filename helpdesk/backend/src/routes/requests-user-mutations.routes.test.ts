import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Express } from 'express';
import { ApiError, errorHandler } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/current-user.js';
import {
  createRequestUserMutationsRouter,
  readUpdateUserFieldsBody,
  serializeCloneDraft,
  serializeRequestSummary,
} from './requests-user-mutations.routes.js';
import {
  RequestForbiddenError,
  RequestNotFoundError,
  UnknownFieldError,
  type CloneDraft,
  type RequestSummary,
  type RequestUserMutationsStore,
  type UpdateUserFieldsInput,
} from './requests-user-mutations.store.js';

/**
 * Tests for the user-side mutation route layer (design: "Requests (user side)",
 * R5.3–5.8). These exercise body parsing, the actor identity coming from
 * `req.currentUser` (never the body), the response shapes, and the mapping of
 * store errors to the uniform error envelope. The store is a hand-rolled fake
 * so no database is touched — matching the injectable-store route style.
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
    status: 'NEW',
    jiraNumber: null,
    estimatedStartDate: null,
    actualStartDate: null,
    createdAt: '2026-02-01T09:00:00.000Z',
    updatedAt: '2026-02-01T10:00:00.000Z',
    ...overrides,
  };
}

function cloneDraft(overrides: Partial<CloneDraft> = {}): CloneDraft {
  return {
    taskId: 42,
    taskName: 'Broken printer',
    teamId: 7,
    sourceTaskVersionId: 900,
    sourceVersionNo: 3,
    title: 'Toner low',
    jiraNumber: 'J-1',
    status: 'NEW',
    fields: [
      {
        taskFieldId: 1,
        dataPointId: 11,
        fieldOrder: 1,
        name: 'Summary',
        dataType: 'TEXT',
        isMandatory: true,
        description: null,
        helpText: null,
        options: null,
        regexpPattern: null,
        value: 'Toner low',
      },
    ],
    ...overrides,
  };
}

/** A fake store; only the methods a given test needs are supplied. */
function fakeStore(overrides: Partial<RequestUserMutationsStore>): RequestUserMutationsStore {
  const notImpl = () => {
    throw new Error('not implemented in this fake');
  };
  return {
    updateUserFields: overrides.updateUserFields ?? (notImpl as never),
    cancel: overrides.cancel ?? (notImpl as never),
    reopen: overrides.reopen ?? (notImpl as never),
    cloneDraft: overrides.cloneDraft ?? (notImpl as never),
  };
}

function stubUser(id: number, teamsMemberOf: number[] = []): CurrentUser {
  return {
    id,
    username: '11111111',
    displayName: 'Test User',
    roles: new Set(['USER']),
    teamsLed: [],
    teamsMemberOf,
    isAdmin: false,
    timezone: null,
  };
}

function appWith(store: RequestUserMutationsStore, userId = 100, teams: number[] = []): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.currentUser = stubUser(userId, teams);
    next();
  });
  app.use('/api', createRequestUserMutationsRouter(store));
  app.use(errorHandler);
  return app;
}

async function send(
  app: Express,
  method: 'PATCH' | 'POST',
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

describe('readUpdateUserFieldsBody (R5.4)', () => {
  it('parses jiraNumber (trimmed) and field values', () => {
    const input = readUpdateUserFieldsBody({
      jiraNumber: '  J-9  ',
      fieldValues: [{ taskFieldId: 1, value: 'x' }],
    });
    assert.equal(input.jiraNumber, 'J-9');
    assert.deepEqual(input.fieldValues, [{ taskFieldId: 1, value: 'x' }]);
  });

  it('distinguishes absent jiraNumber (undefined) from explicit null (clear)', () => {
    const absent = readUpdateUserFieldsBody({ fieldValues: [{ taskFieldId: 1, value: 'x' }] });
    assert.equal(absent.jiraNumber, undefined);
    const cleared = readUpdateUserFieldsBody({ jiraNumber: null });
    assert.equal(cleared.jiraNumber, null);
    const blanked = readUpdateUserFieldsBody({ jiraNumber: '   ' });
    assert.equal(blanked.jiraNumber, null); // blank → null (clear)
  });

  it('rejects an empty patch (neither jira nor fields)', () => {
    assert.throws(() => readUpdateUserFieldsBody({}), (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED');
  });

  it('rejects duplicate taskFieldId entries', () => {
    assert.throws(() =>
      readUpdateUserFieldsBody({
        fieldValues: [
          { taskFieldId: 1, value: 'a' },
          { taskFieldId: 1, value: 'b' },
        ],
      }),
    );
  });
});

// ── PATCH /requests/:id/user-fields (R5.4) ──────────────────────────────────────

describe('PATCH /api/requests/:id/user-fields (R5.4)', () => {
  it('updates fields using the actor from the session and returns 200', async () => {
    let capturedActorId = -1;
    let capturedInput: UpdateUserFieldsInput | null = null;
    const store = fakeStore({
      updateUserFields: async (id, input, actor) => {
        capturedActorId = actor.userId;
        capturedInput = input;
        return summaryRow({ id, jiraNumber: 'J-9' });
      },
    });
    const { status, body } = await send(appWith(store, 100), 'PATCH', '/api/requests/555/user-fields', {
      jiraNumber: 'J-9',
      fieldValues: [{ taskFieldId: 1, value: 'x' }],
    });
    assert.equal(status, 200);
    assert.equal(body['jiraNumber'], 'J-9');
    assert.equal(capturedActorId, 100);
    assert.ok(capturedInput);
  });

  it('maps a non-raiser RequestForbiddenError to 403 FORBIDDEN', async () => {
    const store = fakeStore({
      updateUserFields: async () => {
        throw new RequestForbiddenError(555, 'nope');
      },
    });
    const { status, body } = await send(appWith(store), 'PATCH', '/api/requests/555/user-fields', {
      fieldValues: [{ taskFieldId: 1, value: 'x' }],
    });
    assert.equal(status, 403);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'FORBIDDEN');
  });

  it('maps a MANDATORY_FIELD ApiError from the store through the envelope (409)', async () => {
    const store = fakeStore({
      updateUserFields: async () => {
        throw new ApiError(409, 'MANDATORY_FIELD', 'Summary is required');
      },
    });
    const { status, body } = await send(appWith(store), 'PATCH', '/api/requests/555/user-fields', {
      fieldValues: [{ taskFieldId: 1, value: '' }],
    });
    assert.equal(status, 409);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'MANDATORY_FIELD');
  });

  it('maps UnknownFieldError to 400 VALIDATION_FAILED', async () => {
    const store = fakeStore({
      updateUserFields: async () => {
        throw new UnknownFieldError(999);
      },
    });
    const { status, body } = await send(appWith(store), 'PATCH', '/api/requests/555/user-fields', {
      fieldValues: [{ taskFieldId: 999, value: 'x' }],
    });
    assert.equal(status, 400);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'VALIDATION_FAILED');
  });

  it('rejects a malformed body before touching the store', async () => {
    let called = false;
    const store = fakeStore({
      updateUserFields: async () => {
        called = true;
        return summaryRow();
      },
    });
    const { status } = await send(appWith(store), 'PATCH', '/api/requests/555/user-fields', {});
    assert.equal(status, 400);
    assert.equal(called, false);
  });
});

// ── POST /requests/:id/cancel (R5.5) ────────────────────────────────────────────

describe('POST /api/requests/:id/cancel (R5.5)', () => {
  it('cancels and returns 200 with CANCELLED', async () => {
    const store = fakeStore({
      cancel: async (id) => summaryRow({ id, status: 'CANCELLED' }),
    });
    const { status, body } = await send(appWith(store), 'POST', '/api/requests/555/cancel');
    assert.equal(status, 200);
    assert.equal(body['status'], 'CANCELLED');
  });

  it('maps INVALID_TRANSITION (cancel from stop state) to 409', async () => {
    const store = fakeStore({
      cancel: async () => {
        throw new ApiError(409, 'INVALID_TRANSITION', 'Cannot move a request from COMPLETE to CANCELLED');
      },
    });
    const { status, body } = await send(appWith(store), 'POST', '/api/requests/555/cancel');
    assert.equal(status, 409);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'INVALID_TRANSITION');
  });

  it('maps a non-raiser RequestForbiddenError to 403', async () => {
    const store = fakeStore({
      cancel: async () => {
        throw new RequestForbiddenError(555);
      },
    });
    const { status } = await send(appWith(store), 'POST', '/api/requests/555/cancel');
    assert.equal(status, 403);
  });
});

// ── POST /requests/:id/reopen (R5.6) ────────────────────────────────────────────

describe('POST /api/requests/:id/reopen (R5.6)', () => {
  it('reopens and returns 200 with NEW', async () => {
    const store = fakeStore({
      reopen: async (id) => summaryRow({ id, status: 'NEW' }),
    });
    const { status, body } = await send(appWith(store), 'POST', '/api/requests/555/reopen');
    assert.equal(status, 200);
    assert.equal(body['status'], 'NEW');
  });

  it('maps a non-canceller RequestForbiddenError to 403', async () => {
    const store = fakeStore({
      reopen: async () => {
        throw new RequestForbiddenError(555, 'Only the person who cancelled it may reopen it.');
      },
    });
    const { status, body } = await send(appWith(store), 'POST', '/api/requests/555/reopen');
    assert.equal(status, 403);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'FORBIDDEN');
  });

  it('maps INVALID_TRANSITION (reopen from non-CANCELLED) to 409', async () => {
    const store = fakeStore({
      reopen: async () => {
        throw new ApiError(409, 'INVALID_TRANSITION', 'Cannot reopen a request from NEW to NEW');
      },
    });
    const { status, body } = await send(appWith(store), 'POST', '/api/requests/555/reopen');
    assert.equal(status, 409);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'INVALID_TRANSITION');
  });
});

// ── POST /requests/:id/clone (R5.8) ─────────────────────────────────────────────

describe('POST /api/requests/:id/clone (R5.8)', () => {
  it('returns 200 with a NEW draft echoing the source', async () => {
    let capturedActor = -1;
    const store = fakeStore({
      cloneDraft: async (_id, actor) => {
        capturedActor = actor.userId;
        return cloneDraft();
      },
    });
    const { status, body } = await send(appWith(store, 300), 'POST', '/api/requests/555/clone');
    assert.equal(status, 200);
    assert.equal(body['status'], 'NEW');
    assert.equal(body['title'], 'Toner low');
    assert.equal((body['fields'] as unknown[]).length, 1);
    assert.equal(capturedActor, 300);
  });

  it('maps RequestForbiddenError to 403 and NOT_FOUND to 404', async () => {
    const forbidden = fakeStore({
      cloneDraft: async () => {
        throw new RequestForbiddenError(555);
      },
    });
    assert.equal((await send(appWith(forbidden), 'POST', '/api/requests/555/clone')).status, 403);

    const missing = fakeStore({
      cloneDraft: async () => {
        throw new RequestNotFoundError(999);
      },
    });
    const res = await send(appWith(missing), 'POST', '/api/requests/999/clone');
    assert.equal(res.status, 404);
    assert.equal((res.body['error'] as Record<string, unknown>)['code'], 'NOT_FOUND');
  });
});

// ── Serializers ─────────────────────────────────────────────────────────────────

describe('serializers', () => {
  it('serializeRequestSummary mirrors the row', () => {
    assert.deepEqual(serializeRequestSummary(summaryRow()), {
      id: 555,
      taskReference: 'REQ-ABC-000001',
      taskVersionId: 900,
      title: 'Broken printer',
      raisedById: 100,
      teamId: 7,
      assignedMemberId: null,
      status: 'NEW',
      jiraNumber: null,
      estimatedStartDate: null,
      actualStartDate: null,
      createdAt: '2026-02-01T09:00:00.000Z',
      updatedAt: '2026-02-01T10:00:00.000Z',
    });
  });

  it('serializeCloneDraft mirrors the draft and its fields', () => {
    const json = serializeCloneDraft(cloneDraft());
    assert.equal(json.status, 'NEW');
    assert.equal(json.fields.length, 1);
    assert.equal(json.fields[0].name, 'Summary');
    assert.equal(json.fields[0].value, 'Toner low');
  });
});
