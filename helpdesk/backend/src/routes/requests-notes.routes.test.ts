import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Express } from 'express';
import { errorHandler } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/current-user.js';
import {
  createRequestNotesRouter,
  readAddNoteBody,
  serializeCreatedNote,
} from './requests-notes.routes.js';
import {
  RequestForbiddenError,
  RequestNotFoundError,
  type AddNoteInput,
  type CreatedNote,
  type NoteActor,
  type RequestNotesStore,
} from './requests-notes.store.js';

/**
 * Tests for the UNIFIED add-note route layer (design: single
 * `POST /api/requests/{id}/notes` — raiser external only R5.3, support internal
 * or external R7.3–7.6). These exercise body parsing (`{ body, isInternal }`),
 * the actor coming from `req.currentUser` (never the body), the response shape,
 * and the mapping of store errors to the uniform envelope. The store is a
 * hand-rolled fake so no database is touched.
 */

function noteRow(overrides: Partial<CreatedNote> = {}): CreatedNote {
  return {
    id: 77,
    requestId: 555,
    authorId: 100,
    isInternal: false,
    body: 'Please hurry',
    createdAt: '2026-02-02T09:00:00.000Z',
    ...overrides,
  };
}

/** A fake store; only the method a given test needs is supplied. */
function fakeStore(addNote?: RequestNotesStore['addNote']): RequestNotesStore {
  return {
    addNote:
      addNote ??
      (() => {
        throw new Error('not implemented in this fake');
      }),
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

function appWith(store: RequestNotesStore, userId = 100, teams: number[] = []): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.currentUser = stubUser(userId, teams);
    next();
  });
  app.use('/api', createRequestNotesRouter(store));
  app.use(errorHandler);
  return app;
}

async function send(
  app: Express,
  method: 'POST',
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

describe('readAddNoteBody (R5.3, R7.3–7.4)', () => {
  it('parses and trims a non-blank body, defaulting isInternal to false', () => {
    const input = readAddNoteBody({ body: '  hello  ' });
    assert.deepEqual(input, { body: 'hello', isInternal: false });
  });

  it('parses an explicit isInternal boolean', () => {
    assert.equal(readAddNoteBody({ body: 'x', isInternal: true }).isInternal, true);
    assert.equal(readAddNoteBody({ body: 'x', isInternal: false }).isInternal, false);
  });

  it('rejects a blank/missing body', () => {
    assert.throws(() => readAddNoteBody({ body: '   ' }));
    assert.throws(() => readAddNoteBody({}));
    assert.throws(() => readAddNoteBody(null));
  });

  it('rejects a non-boolean isInternal', () => {
    assert.throws(() => readAddNoteBody({ body: 'x', isInternal: 'yes' }));
  });
});

// ── POST /requests/:id/notes ─────────────────────────────────────────────────

describe('POST /api/requests/:id/notes (R5.3, R7.3–7.6)', () => {
  it('passes body + isInternal + session actor to the store and returns 201', async () => {
    let capturedId = -1;
    let capturedInput: AddNoteInput | null = null;
    let capturedActor: NoteActor | null = null;
    const store = fakeStore(async (id, input, actor) => {
      capturedId = id;
      capturedInput = input;
      capturedActor = actor;
      return noteRow({ requestId: id, authorId: actor.userId, isInternal: input.isInternal });
    });

    // A support member of team 7 adds an internal note.
    const { status, body } = await send(
      appWith(store, 200, [7]),
      'POST',
      '/api/requests/555/notes',
      { body: 'support only', isInternal: true },
    );

    assert.equal(status, 201);
    assert.equal(body['isInternal'], true);
    assert.equal(body['authorId'], 200);
    assert.equal(capturedId, 555);
    assert.deepEqual(capturedInput, { body: 'support only', isInternal: true });
    // The actor identity comes from the session, never the body.
    const actor = capturedActor as NoteActor | null;
    assert.equal(actor?.userId, 200);
    assert.deepEqual(actor?.teamsMemberOf, [7]);
  });

  it('defaults isInternal to false when omitted (external note)', async () => {
    let capturedInput: AddNoteInput | null = null;
    const store = fakeStore(async (id, input) => {
      capturedInput = input;
      return noteRow({ requestId: id, body: input.body, isInternal: input.isInternal });
    });

    const { status, body } = await send(appWith(store, 100), 'POST', '/api/requests/555/notes', {
      body: 'visible to raiser',
    });

    assert.equal(status, 201);
    assert.equal(body['isInternal'], false);
    assert.deepEqual(capturedInput, { body: 'visible to raiser', isInternal: false });
  });

  it('maps a RequestForbiddenError to 403', async () => {
    const store = fakeStore(async () => {
      throw new RequestForbiddenError(555);
    });
    const { status } = await send(appWith(store, 300, [9]), 'POST', '/api/requests/555/notes', {
      body: 'hi',
    });
    assert.equal(status, 403);
  });

  it('maps a RequestNotFoundError to 404', async () => {
    const store = fakeStore(async () => {
      throw new RequestNotFoundError(999);
    });
    const { status } = await send(appWith(store), 'POST', '/api/requests/999/notes', {
      body: 'hi',
    });
    assert.equal(status, 404);
  });

  it('rejects a blank body with 400 VALIDATION_FAILED', async () => {
    const store = fakeStore(async () => noteRow());
    const { status, body } = await send(appWith(store), 'POST', '/api/requests/555/notes', {
      body: '   ',
    });
    assert.equal(status, 400);
    const envelope = body['error'] as Record<string, unknown>;
    assert.equal(envelope['code'], 'VALIDATION_FAILED');
  });
});

// ── Serializer ────────────────────────────────────────────────────────────────

describe('serializeCreatedNote', () => {
  it('mirrors the note as camelCase JSON', () => {
    assert.deepEqual(serializeCreatedNote(noteRow({ isInternal: true })), {
      id: 77,
      requestId: 555,
      authorId: 100,
      isInternal: true,
      body: 'Please hurry',
      createdAt: '2026-02-02T09:00:00.000Z',
    });
  });
});
