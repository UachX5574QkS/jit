import { Router, type RequestHandler } from 'express';
import { ApiError, errors } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/index.js';
import { STATUSES, isStatus, type Status } from '../status/index.js';
import {
  AssigneeNotInTeamError,
  DbRequestSupportMutationsStore,
  RequestForbiddenError,
  RequestNotFoundError,
  UnknownFieldError,
  type RequestSummary,
  type RequestSupportMutationsStore,
  type SupportActor,
  type SupportFieldUpdate,
  type UpdateRequestInput,
} from './requests-support-mutations.store.js';

/**
 * Support-side request mutation (design: "Support side" —
 * `PATCH /api/requests/{id}` — support update of any field + status
 * (state-machine checked) + assignment; R7.1, R7.2, R9).
 *
 *   PATCH /api/requests/{id}   a support member of the request's team updates
 *                              any field value, the Jira number, the
 *                              estimated/actual start dates, the status (via the
 *                              central state machine), and/or the assignment
 *                              (any team member, or unassign).
 *
 * ── Path & wiring ────────────────────────────────────────────────────────────
 * This is the PLAIN `PATCH /api/requests/:id` (no subpath). The user-side
 * mutations own `/requests/:id/user-fields`, `/notes`, `/cancel`, `/reopen` and
 * `/clone`; those are distinct sub-paths, so registering `PATCH /requests/:id`
 * on the same requests router (mounted at `/api`) does not collide with them.
 * The support QUEUE list lives under `/api/support/requests` (task 7.1); the
 * design places this support UPDATE under `/api/requests/{id}`, so it is wired
 * onto the requests router alongside the user-side routes.
 *
 * ── Authorisation ────────────────────────────────────────────────────────────
 * Available to any authenticated user; the global `authenticate` middleware
 * upstream guarantees `req.currentUser`. The fine-grained gate (the actor must
 * be a support member of the REQUEST'S team, R7.1/R7.2) lives in the store,
 * which knows the request's `team_id`; a denial surfaces here as 403 FORBIDDEN
 * and an unknown id as 404 NOT_FOUND.
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 * The handler depends on the narrow {@link RequestSupportMutationsStore} so it
 * unit-tests with an in-memory fake (no database). Production wiring uses
 * {@link DbRequestSupportMutationsStore}.
 */

// ── Public JSON view (camelCase, ISO dates) ────────────────────────────────────

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

/** Build the {@link SupportActor} the store consumes from the current user. */
function toActor(user: CurrentUser): SupportActor {
  return { userId: user.id, teamsMemberOf: user.teamsMemberOf };
}

/**
 * Normalise one entry of the `fieldValues` array. Returns a
 * {@link SupportFieldUpdate} or throws `VALIDATION_FAILED` for a malformed
 * entry. The value stays a raw string (or null to clear) — TYPE and mandatory
 * validation is the store's job against the pinned version (R7.1).
 */
function readFieldUpdate(raw: unknown): SupportFieldUpdate {
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

/** Read an optional nullable string column (jira / dates): absent → undefined. */
function readNullableString(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!(key in record)) {
    return undefined;
  }
  const raw = record[key];
  if (raw === null) {
    return null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  }
  throw errors.validationFailed(`${key} must be a string or null.`, { field: key });
}

/** Parse the optional `status` field: must be one of the known statuses. */
function readStatus(record: Record<string, unknown>): Status | undefined {
  if (!('status' in record)) {
    return undefined;
  }
  const raw = record['status'];
  if (typeof raw === 'string' && isStatus(raw)) {
    return raw;
  }
  throw errors.validationFailed(`status must be one of: ${STATUSES.join(', ')}.`, {
    field: 'status',
  });
}

/**
 * Parse the optional `assignedMemberId`: absent → undefined (unchanged); `null`
 * → unassign; a positive integer → assign. Any other value is VALIDATION_FAILED.
 */
function readAssignedMemberId(
  record: Record<string, unknown>,
): number | null | undefined {
  if (!('assignedMemberId' in record)) {
    return undefined;
  }
  const raw = record['assignedMemberId'];
  if (raw === null) {
    return null;
  }
  const id = toPositiveInt(raw);
  if (id === null) {
    throw errors.validationFailed(
      'assignedMemberId must be a positive integer or null.',
      { field: 'assignedMemberId' },
    );
  }
  return id;
}

/**
 * Parse the support PATCH body (R7.1, R7.2, R9). Every property is optional and
 * absent means "leave unchanged"; an explicit `null` clears a nullable column
 * (jira/dates) or unassigns (`assignedMemberId`). At least one changeable
 * property must be present — an empty patch is a no-op bad request.
 */
export function readUpdateRequestBody(body: unknown): UpdateRequestInput {
  if (typeof body !== 'object' || body === null) {
    throw errors.validationFailed('A JSON body is required.', { field: 'body' });
  }
  const record = body as Record<string, unknown>;

  const jiraNumber = readNullableString(record, 'jiraNumber');
  const estimatedStartDate = readNullableString(record, 'estimatedStartDate');
  const actualStartDate = readNullableString(record, 'actualStartDate');
  const status = readStatus(record);
  const assignedMemberId = readAssignedMemberId(record);

  const rawFieldValues = record['fieldValues'];
  const fieldValues: SupportFieldUpdate[] = [];
  let hasFieldValues = false;
  if (rawFieldValues !== undefined) {
    if (!Array.isArray(rawFieldValues)) {
      throw errors.validationFailed('fieldValues must be an array.', {
        field: 'fieldValues',
      });
    }
    hasFieldValues = true;
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

  const nothingToChange =
    jiraNumber === undefined &&
    estimatedStartDate === undefined &&
    actualStartDate === undefined &&
    status === undefined &&
    assignedMemberId === undefined &&
    !hasFieldValues;
  if (nothingToChange) {
    throw errors.validationFailed('Provide at least one property to update.', {
      field: 'body',
    });
  }

  const input: {
    -readonly [K in keyof UpdateRequestInput]: UpdateRequestInput[K];
  } = {};
  if (hasFieldValues) {
    input.fieldValues = fieldValues;
  }
  if (jiraNumber !== undefined) {
    input.jiraNumber = jiraNumber;
  }
  if (estimatedStartDate !== undefined) {
    input.estimatedStartDate = estimatedStartDate;
  }
  if (actualStartDate !== undefined) {
    input.actualStartDate = actualStartDate;
  }
  if (status !== undefined) {
    input.status = status;
  }
  if (assignedMemberId !== undefined) {
    input.assignedMemberId = assignedMemberId;
  }
  return input;
}

/**
 * Map a store error to the uniform envelope. `RequestNotFoundError` → 404,
 * `RequestForbiddenError` → 403 FORBIDDEN, `UnknownFieldError` /
 * `AssigneeNotInTeamError` → `VALIDATION_FAILED` (400). Anything else (incl. the
 * status machine's `INVALID_TRANSITION` ApiError and the validator's
 * MANDATORY_FIELD/VALIDATION_FAILED) is re-thrown unchanged for the shared
 * error handler.
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
  if (err instanceof AssigneeNotInTeamError) {
    throw errors.validationFailed(
      'The assignee must be a member of the request team.',
      { assigneeId: err.assigneeId, teamId: err.teamId },
    );
  }
  throw err;
}

// ── Handler ─────────────────────────────────────────────────────────────────────

/** PATCH /requests/:id — support update of fields + status + assignment (R7.1–7.2, R9). */
export function makeUpdateRequestHandler(
  store: RequestSupportMutationsStore,
): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const id = requestIdParam(req as never);
      const input = readUpdateRequestBody(req.body);
      const actor = toActor(currentUser(req));
      try {
        const row = await store.updateRequest(id, input, actor);
        res.status(200).json(serializeRequestSummary(row));
      } catch (err) {
        mapStoreError(err);
      }
    })().catch(next);
  };
}

/**
 * Register the support-mutation route on a router (mounted at `/api`), so the
 * full path is `PATCH /api/requests/:id`. The store is injected for
 * testability; production uses {@link DbRequestSupportMutationsStore}.
 */
export function registerRequestSupportMutationRoutes(
  router: Router,
  store: RequestSupportMutationsStore,
): Router {
  router.patch('/requests/:id', makeUpdateRequestHandler(store));
  return router;
}

/** A standalone router (used by tests and for isolated wiring). */
export function createRequestSupportMutationsRouter(
  store: RequestSupportMutationsStore,
): Router {
  return registerRequestSupportMutationRoutes(Router(), store);
}
