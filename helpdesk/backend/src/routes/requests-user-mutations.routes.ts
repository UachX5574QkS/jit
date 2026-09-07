import { Router, type RequestHandler } from 'express';
import { ApiError, errors } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/index.js';
import {
  DbRequestUserMutationsStore,
  RequestForbiddenError,
  RequestNotFoundError,
  UnknownFieldError,
  type CloneDraft,
  type CloneFieldView,
  type MutationActor,
  type RequestSummary,
  type RequestUserMutationsStore,
  type UpdateUserFieldsInput,
  type UserFieldUpdate,
} from './requests-user-mutations.store.js';

/**
 * User-side request mutations (design: "Requests (user side)" — R5.3–5.8):
 *
 *   PATCH /api/requests/{id}/user-fields  raiser updates Jira + user fields;
 *                                         mandatory not blankable (R5.4)
 *   POST  /api/requests/{id}/cancel       raiser, non-stop → CANCELLED (R5.5)
 *   POST  /api/requests/{id}/reopen       raiser-who-cancelled, CANCELLED → NEW (R5.6)
 *   POST  /api/requests/{id}/clone        pre-populated draft for Step 2 (R5.8)
 *
 * ── Authorisation ────────────────────────────────────────────────────────────
 * Available to any authenticated user; the global {@link authenticate}
 * middleware mounted ahead of the requests router rejects unauthenticated
 * callers with 401, so `req.currentUser` is always present. The fine-grained
 * gate (raiser for mutate; raiser-who-cancelled for reopen; authorised viewer
 * for clone) lives in the store, which knows the request's `raised_by_id`,
 * team, and who cancelled it. A denial surfaces here as 403 FORBIDDEN and an
 * unknown id as 404 NOT_FOUND — R5.7 (no user status changes outside
 * cancel/reopen) is enforced by construction: the only status transitions the
 * store performs are cancel and reopen.
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 * The handlers depend on the narrow {@link RequestUserMutationsStore} so they
 * unit-test with an in-memory fake (no database). Production wiring uses
 * {@link DbRequestUserMutationsStore}.
 */

// ── Public JSON views (camelCase, ISO dates) ───────────────────────────────────

export interface RequestSummaryJson {
  readonly id: number;
  readonly taskReference: string;
  readonly taskVersionId: number;
  readonly title: string;
  readonly raisedById: number;
  readonly teamId: number;
  readonly assignedMemberId: number | null;
  readonly status: string;
  readonly jiraNumber: string | null;
  readonly estimatedStartDate: string | null;
  readonly actualStartDate: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CloneFieldJson {
  readonly taskFieldId: number;
  readonly dataPointId: number;
  readonly fieldOrder: number;
  readonly name: string;
  readonly dataType: string;
  readonly isMandatory: boolean;
  readonly description: string | null;
  readonly helpText: string | null;
  readonly options: string[] | null;
  readonly regexpPattern: string | null;
  readonly value: string | null;
}

export interface CloneDraftJson {
  readonly taskId: number;
  readonly taskName: string;
  readonly teamId: number;
  readonly sourceTaskVersionId: number;
  readonly sourceVersionNo: number;
  readonly title: string;
  readonly jiraNumber: string | null;
  readonly status: 'NEW';
  readonly fields: CloneFieldJson[];
}

export function serializeRequestSummary(row: RequestSummary): RequestSummaryJson {
  return {
    id: row.id,
    taskReference: row.taskReference,
    taskVersionId: row.taskVersionId,
    title: row.title,
    raisedById: row.raisedById,
    teamId: row.teamId,
    assignedMemberId: row.assignedMemberId,
    status: row.status,
    jiraNumber: row.jiraNumber,
    estimatedStartDate: row.estimatedStartDate,
    actualStartDate: row.actualStartDate,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function serializeCloneField(f: CloneFieldView): CloneFieldJson {
  return {
    taskFieldId: f.taskFieldId,
    dataPointId: f.dataPointId,
    fieldOrder: f.fieldOrder,
    name: f.name,
    dataType: f.dataType,
    isMandatory: f.isMandatory,
    description: f.description,
    helpText: f.helpText,
    options: f.options,
    regexpPattern: f.regexpPattern,
    value: f.value,
  };
}

export function serializeCloneDraft(draft: CloneDraft): CloneDraftJson {
  return {
    taskId: draft.taskId,
    taskName: draft.taskName,
    teamId: draft.teamId,
    sourceTaskVersionId: draft.sourceTaskVersionId,
    sourceVersionNo: draft.sourceVersionNo,
    title: draft.title,
    jiraNumber: draft.jiraNumber,
    status: draft.status,
    fields: draft.fields.map(serializeCloneField),
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

/** Build the {@link MutationActor} the store consumes from the current user. */
function toActor(user: CurrentUser): MutationActor {
  return { userId: user.id, teamsMemberOf: user.teamsMemberOf };
}

/**
 * Normalise one entry of the `fieldValues` array for a user-fields patch.
 * Returns a {@link UserFieldUpdate} or throws `VALIDATION_FAILED` for a
 * malformed entry. The value stays a raw string (or null to clear) — TYPE and
 * mandatory validation is the store's job against the pinned version (R5.4).
 */
function readFieldUpdate(raw: unknown): UserFieldUpdate {
  if (typeof raw !== 'object' || raw === null) {
    throw errors.validationFailed('Each field value must be an object.', {
      field: 'fieldValues',
    });
  }
  const obj = raw as Record<string, unknown>;
  const taskFieldId = toPositiveInt(obj['taskFieldId']);
  if (taskFieldId === null) {
    throw errors.validationFailed('Each field value needs a valid taskFieldId.', {
      field: 'fieldValues',
    });
  }
  const rawValue = obj['value'];
  let value: string | null;
  if (rawValue === undefined || rawValue === null) {
    value = null;
  } else if (typeof rawValue === 'string') {
    value = rawValue;
  } else if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
    value = String(rawValue);
  } else {
    throw errors.validationFailed('A field value must be a string, number, or boolean.', {
      field: 'fieldValues',
      taskFieldId,
    });
  }
  return { taskFieldId, value };
}

/**
 * Parse the user-fields PATCH body (R5.4). `jiraNumber` is optional: absent →
 * left unchanged; null/blank → cleared; a string → trimmed. `fieldValues` is an
 * optional array of `{ taskFieldId, value }`; duplicate ids are rejected early
 * (the DB has a unique(request,field) constraint). At least one of jiraNumber or
 * a field value must be present — an empty patch is a no-op bad request.
 */
export function readUpdateUserFieldsBody(body: unknown): UpdateUserFieldsInput {
  if (typeof body !== 'object' || body === null) {
    throw errors.validationFailed('A JSON body is required.', { field: 'body' });
  }
  const record = body as Record<string, unknown>;

  // jiraNumber: present-vs-absent is meaningful, so distinguish them.
  let jiraNumber: string | null | undefined;
  if (!('jiraNumber' in record)) {
    jiraNumber = undefined;
  } else {
    const raw = record['jiraNumber'];
    if (raw === null) {
      jiraNumber = null;
    } else if (typeof raw === 'string') {
      const trimmed = raw.trim();
      jiraNumber = trimmed === '' ? null : trimmed;
    } else {
      throw errors.validationFailed('jiraNumber must be a string or null.', {
        field: 'jiraNumber',
      });
    }
  }

  const rawFieldValues = record['fieldValues'];
  const fieldValues: UserFieldUpdate[] = [];
  if (rawFieldValues !== undefined) {
    if (!Array.isArray(rawFieldValues)) {
      throw errors.validationFailed('fieldValues must be an array.', {
        field: 'fieldValues',
      });
    }
    const seen = new Set<number>();
    for (const entry of rawFieldValues) {
      const update = readFieldUpdate(entry);
      if (seen.has(update.taskFieldId)) {
        throw errors.validationFailed('Duplicate taskFieldId in fieldValues.', {
          field: 'fieldValues',
          taskFieldId: update.taskFieldId,
        });
      }
      seen.add(update.taskFieldId);
      fieldValues.push(update);
    }
  }

  if (jiraNumber === undefined && fieldValues.length === 0) {
    throw errors.validationFailed(
      'Provide a jiraNumber and/or at least one field value to update.',
      { field: 'body' },
    );
  }

  return { jiraNumber, fieldValues };
}

/**
 * Map a store error to the uniform envelope. `RequestNotFoundError` → 404,
 * `RequestForbiddenError` → 403 FORBIDDEN, `UnknownFieldError` →
 * `VALIDATION_FAILED` (400). Anything else (incl. the status machine's
 * `INVALID_TRANSITION` ApiError and the validator's MANDATORY_FIELD/
 * VALIDATION_FAILED) is re-thrown unchanged for the shared error handler.
 */
function mapStoreError(err: unknown): never {
  if (err instanceof RequestNotFoundError) {
    throw ApiError.of('NOT_FOUND', 'Request not found.', { requestId: err.requestId });
  }
  if (err instanceof RequestForbiddenError) {
    throw errors.forbidden(err.message, { requestId: err.requestId });
  }
  if (err instanceof UnknownFieldError) {
    throw errors.validationFailed(
      'A submitted value does not belong to the request version.',
      { taskFieldId: err.taskFieldId },
    );
  }
  throw err;
}

// ── Handlers ────────────────────────────────────────────────────────────────────

/** PATCH /requests/:id/user-fields — raiser updates Jira + user fields (R5.4). */
export function makeUpdateUserFieldsHandler(
  store: RequestUserMutationsStore,
): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const id = requestIdParam(req as never);
      const input = readUpdateUserFieldsBody(req.body);
      const actor = toActor(currentUser(req));
      try {
        const row = await store.updateUserFields(id, input, actor);
        res.status(200).json(serializeRequestSummary(row));
      } catch (err) {
        mapStoreError(err);
      }
    })().catch(next);
  };
}

/** POST /requests/:id/cancel — raiser cancels a non-stop request (R5.5). */
export function makeCancelHandler(store: RequestUserMutationsStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const id = requestIdParam(req as never);
      const actor = toActor(currentUser(req));
      try {
        const row = await store.cancel(id, actor);
        res.status(200).json(serializeRequestSummary(row));
      } catch (err) {
        mapStoreError(err);
      }
    })().catch(next);
  };
}

/** POST /requests/:id/reopen — raiser-who-cancelled reopens (R5.6). */
export function makeReopenHandler(store: RequestUserMutationsStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const id = requestIdParam(req as never);
      const actor = toActor(currentUser(req));
      try {
        const row = await store.reopen(id, actor);
        res.status(200).json(serializeRequestSummary(row));
      } catch (err) {
        mapStoreError(err);
      }
    })().catch(next);
  };
}

/** POST /requests/:id/clone — pre-populated draft for Step 2 (R5.8). */
export function makeCloneHandler(store: RequestUserMutationsStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const id = requestIdParam(req as never);
      const actor = toActor(currentUser(req));
      try {
        const draft = await store.cloneDraft(id, actor);
        res.status(200).json(serializeCloneDraft(draft));
      } catch (err) {
        mapStoreError(err);
      }
    })().catch(next);
  };
}

/**
 * Register the user-side mutation routes on a router (mounted at `/api`). The
 * store is injected for testability; production uses
 * {@link DbRequestUserMutationsStore}.
 */
export function registerRequestUserMutationRoutes(
  router: Router,
  store: RequestUserMutationsStore,
): Router {
  router.patch('/requests/:id/user-fields', makeUpdateUserFieldsHandler(store));
  router.post('/requests/:id/cancel', makeCancelHandler(store));
  router.post('/requests/:id/reopen', makeReopenHandler(store));
  router.post('/requests/:id/clone', makeCloneHandler(store));
  return router;
}

/** A standalone router (used by tests and for isolated wiring). */
export function createRequestUserMutationsRouter(
  store: RequestUserMutationsStore,
): Router {
  return registerRequestUserMutationRoutes(Router(), store);
}
