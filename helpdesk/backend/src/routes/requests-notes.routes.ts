import { Router, type RequestHandler } from 'express';
import { ApiError, errors } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/index.js';
import {
  DbRequestNotesStore,
  RequestForbiddenError,
  RequestNotFoundError,
  type AddNoteInput,
  type CreatedNote,
  type NoteActor,
  type RequestNotesStore,
} from './requests-notes.store.js';

/**
 * The UNIFIED add-note route (design: `POST /api/requests/{id}/notes` — listed
 * for BOTH the raiser (external only, R5.3) and support (internal or external,
 * R7.3–7.4)):
 *
 *   POST /api/requests/{id}/notes   { body, isInternal? } → 201 CreatedNote
 *
 * One endpoint serves both audiences; the store branches on the caller's
 * relationship to the request (support member of the team → `isInternal`
 * honoured; raiser → forced external; else FORBIDDEN). This replaces the
 * separate user-side add-note wiring so the two never collide on the same path.
 *
 * ── "Updated"-trigger behaviour (R7.5, R7.6) ─────────────────────────────────
 * The store bumps `request.updated_at` for an EXTERNAL note (fires the raiser's
 * "Updated" indicator) and leaves it unchanged for an INTERNAL note (which must
 * not flag the raiser's Requests view but still shows to support).
 *
 * ── Authorisation ────────────────────────────────────────────────────────────
 * Available to any authenticated user; the global `authenticate` middleware
 * upstream guarantees `req.currentUser`. The fine-grained gate (raiser or
 * support member of the request's team) lives in the store, which knows the
 * request's `raised_by_id` and `team_id`; a denial surfaces here as 403
 * FORBIDDEN and an unknown id as 404 NOT_FOUND.
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 * The handler depends on the narrow {@link RequestNotesStore} so it unit-tests
 * with an in-memory fake (no database). Production wiring uses
 * {@link DbRequestNotesStore}.
 */

// ── Public JSON view (camelCase, ISO dates) ────────────────────────────────────

export interface CreatedNoteJson {
  readonly id: number;
  readonly requestId: number;
  readonly authorId: number;
  readonly isInternal: boolean;
  readonly body: string;
  readonly createdAt: string;
}

export function serializeCreatedNote(note: CreatedNote): CreatedNoteJson {
  return {
    id: note.id,
    requestId: note.requestId,
    authorId: note.authorId,
    isInternal: note.isInternal,
    body: note.body,
    createdAt: note.createdAt,
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

/** Build the {@link NoteActor} the store consumes from the current user. */
function toActor(user: CurrentUser): NoteActor {
  return { userId: user.id, teamsMemberOf: user.teamsMemberOf };
}

/**
 * Parse the add-note body (R5.3, R7.3–7.4): a non-blank `body` string and an
 * optional `isInternal` boolean (default `false`). Whether an `isInternal:true`
 * is actually honoured is decided by the store from the caller's relationship
 * to the request (support member vs raiser) — the route only parses the intent.
 */
export function readAddNoteBody(body: unknown): AddNoteInput {
  if (typeof body !== 'object' || body === null) {
    throw errors.validationFailed('A JSON body is required.', { field: 'body' });
  }
  const record = body as Record<string, unknown>;

  const rawBody = record['body'];
  if (typeof rawBody !== 'string' || rawBody.trim() === '') {
    throw errors.validationFailed('A non-empty note body is required.', { field: 'body' });
  }

  let isInternal = false;
  if ('isInternal' in record) {
    const raw = record['isInternal'];
    if (typeof raw !== 'boolean') {
      throw errors.validationFailed('isInternal must be a boolean.', {
        field: 'isInternal',
      });
    }
    isInternal = raw;
  }

  return { body: rawBody.trim(), isInternal };
}

/**
 * Map a store error to the uniform envelope. `RequestNotFoundError` → 404,
 * `RequestForbiddenError` → 403 FORBIDDEN. Anything else is re-thrown unchanged
 * for the shared error handler.
 */
function mapStoreError(err: unknown): never {
  if (err instanceof RequestNotFoundError) {
    throw ApiError.of('NOT_FOUND', 'Request not found.', { requestId: err.requestId });
  }
  if (err instanceof RequestForbiddenError) {
    throw errors.forbidden(err.message, { requestId: err.requestId });
  }
  throw err;
}

// ── Handler ─────────────────────────────────────────────────────────────────────

/** POST /requests/:id/notes — add an internal or external note (R5.3, R7.3–7.6). */
export function makeAddNoteHandler(store: RequestNotesStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const id = requestIdParam(req as never);
      const input = readAddNoteBody(req.body);
      const actor = toActor(currentUser(req));
      try {
        const note = await store.addNote(id, input, actor);
        res.status(201).json(serializeCreatedNote(note));
      } catch (err) {
        mapStoreError(err);
      }
    })().catch(next);
  };
}

/**
 * Register the unified add-note route on a router (mounted at `/api`), so the
 * full path is `POST /api/requests/:id/notes`. The store is injected for
 * testability; production uses {@link DbRequestNotesStore}.
 */
export function registerRequestNotesRoutes(
  router: Router,
  store: RequestNotesStore,
): Router {
  router.post('/requests/:id/notes', makeAddNoteHandler(store));
  return router;
}

/** A standalone router (used by tests and for isolated wiring). */
export function createRequestNotesRouter(store: RequestNotesStore): Router {
  return registerRequestNotesRoutes(Router(), store);
}
