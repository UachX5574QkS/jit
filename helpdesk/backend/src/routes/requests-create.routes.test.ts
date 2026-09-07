import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Express } from 'express';
import { errorHandler } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/current-user.js';
import {
  createRequestCreateRouter,
  readCreateRequestBody,
  serializeCreatedRequest,
} from './requests-create.routes.js';
import {
  TaskNotFoundError,
  UnknownFieldError,
  type CreateRequestInput,
  type CreatedRequestRow,
  type RequestCreateStore,
} from './requests-create.store.js';

/**
 * Tests for the `POST /api/requests` route layer (design: "Requests (user
 * side)", R2.14). These exercise body parsing, the raiser identity coming from
 * `req.currentUser` (never the body), the 201 response shape, and the mapping
 * of store errors to the uniform error envelope. The store is a hand-rolled
 * fake so no database is touched — matching the injectable-store route style.
 */

/** A created-request row the fake store returns. */
function createdRow(overrides: Partial<CreatedRequestRow> = {}): CreatedRequestRow {
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
    updatedAt: '2026-02-01T09:00:00.000Z',
    ...overrides,
  };
}

/** Build a fake store whose `create` is the supplied function. */
function fakeStore(
  create: (input: CreateRequestInput, raisedById: number) => Promise<CreatedRequestRow>,
): RequestCreateStore {
  return { create };
}

/** A minimal current user stub for the injected authenticate stand-in. */
function stubUser(id: number): CurrentUser {
  return {
    id,
    username: '11111111',
    displayName: 'Test User',
    roles: new Set(['USER']),
    teamsLed: [],
    teamsMemberOf: [],
    isAdmin: false,
    timezone: null,
  };
}

/** Mount the create-request router behind a stub that attaches a current user. */
function appWith(store: RequestCreateStore, userId = 100): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.currentUser = stubUser(userId);
    next();
  });
  app.use('/api', createRequestCreateRouter(store));
  app.use(errorHandler);
  return app;
}

/** Fire a POST /api/requests against the app and return status + parsed body. */
async function postRequest(
  app: Express,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/requests`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const parsed = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('readCreateRequestBody (R2.14)', () => {
  it('parses a valid body with optional fields normalised', () => {
    const input = readCreateRequestBody({
      taskId: 42,
      title: '  Broken printer  ',
      jiraNumber: '  JIRA-1  ',
      estimatedStartDate: '2026-02-02T00:00:00.000Z',
      actualStartDate: '',
      fieldValues: [{ taskFieldId: 1, value: 'Toner low' }],
    });
    assert.equal(input.taskId, 42);
    assert.equal(input.title, 'Broken printer');
    assert.equal(input.jiraNumber, 'JIRA-1');
    assert.equal(input.estimatedStartDate, '2026-02-02T00:00:00.000Z');
    assert.equal(input.actualStartDate, null); // blank → null
    assert.deepEqual(input.fieldValues, [{ taskFieldId: 1, value: 'Toner low' }]);
  });

  it('rejects a missing/blank title and a bad taskId', () => {
    assert.throws(() => readCreateRequestBody({ taskId: 1, title: '   ' }));
    assert.throws(() => readCreateRequestBody({ taskId: 0, title: 'x' }));
    assert.throws(() => readCreateRequestBody(null));
  });

  it('rejects duplicate taskFieldId entries', () => {
    assert.throws(() =>
      readCreateRequestBody({
        taskId: 1,
        title: 'x',
        fieldValues: [
          { taskFieldId: 1, value: 'a' },
          { taskFieldId: 1, value: 'b' },
        ],
      }),
    );
  });

  it('coerces numeric/boolean field values to strings and null-omits missing ones', () => {
    const input = readCreateRequestBody({
      taskId: 1,
      title: 'x',
      fieldValues: [
        { taskFieldId: 1, value: 42 },
        { taskFieldId: 2, value: true },
        { taskFieldId: 3 },
      ],
    });
    assert.deepEqual(input.fieldValues, [
      { taskFieldId: 1, value: '42' },
      { taskFieldId: 2, value: 'true' },
      { taskFieldId: 3, value: null },
    ]);
  });
});

describe('serializeCreatedRequest', () => {
  it('mirrors the store row into the public JSON view', () => {
    assert.deepEqual(serializeCreatedRequest(createdRow()), {
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
      updatedAt: '2026-02-01T09:00:00.000Z',
    });
  });
});

describe('POST /api/requests (R2.14)', () => {
  it('creates a request with the raiser from the session and returns 201 + NEW', async () => {
    let capturedRaiser = -1;
    let capturedInput: CreateRequestInput | null = null;
    const store = fakeStore(async (input, raisedById) => {
      capturedRaiser = raisedById;
      capturedInput = input;
      return createdRow({ raisedById });
    });

    const { status, body } = await postRequest(appWith(store, 100), {
      taskId: 42,
      title: 'Broken printer',
      raisedById: 999, // must be IGNORED — identity comes from the session
      fieldValues: [{ taskFieldId: 1, value: 'Toner low' }],
    });

    assert.equal(status, 201);
    assert.equal(body['status'], 'NEW');
    assert.equal(body['taskReference'], 'REQ-ABC-000001');
    assert.equal(capturedRaiser, 100); // session user, not the body's 999
    assert.equal(body['raisedById'], 100);
    assert.ok(capturedInput);
  });

  it('maps TaskNotFoundError to a 404 NOT_FOUND envelope', async () => {
    const store = fakeStore(async () => {
      throw new TaskNotFoundError(42);
    });
    const { status, body } = await postRequest(appWith(store), {
      taskId: 42,
      title: 'x',
    });
    assert.equal(status, 404);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'NOT_FOUND');
  });

  it('maps UnknownFieldError to a 400 VALIDATION_FAILED envelope', async () => {
    const store = fakeStore(async () => {
      throw new UnknownFieldError(999);
    });
    const { status, body } = await postRequest(appWith(store), {
      taskId: 42,
      title: 'x',
      fieldValues: [{ taskFieldId: 999, value: 'y' }],
    });
    assert.equal(status, 400);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'VALIDATION_FAILED');
  });

  it('rejects a malformed body with 400 VALIDATION_FAILED before touching the store', async () => {
    let called = false;
    const store = fakeStore(async () => {
      called = true;
      return createdRow();
    });
    const { status, body } = await postRequest(appWith(store), { title: 'no task id' });
    assert.equal(status, 400);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'VALIDATION_FAILED');
    assert.equal(called, false);
  });
});
