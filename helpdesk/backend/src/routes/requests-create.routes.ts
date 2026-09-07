import { Router, type RequestHandler } from 'express';
import { ApiError, errors } from '../middleware/errors.js';
import {
  DbRequestCreateStore,
  TaskNotFoundError,
  UnknownFieldError,
  type CreateRequestInput,
  type CreatedRequestRow,
  type RequestCreateStore,
  type SubmittedFieldValue,
} from './requests-create.store.js';

/**
 * `POST /api/requests` — submit a request from the New workflow (design:
 * "Requests (user side)" — `POST /api/requests`, R2.14).
 *
 * ── Authorisation ────────────────────────────────────────────────────────────
 * Available to ANY authenticated user — every user may raise a request (R2.1).
 * The global {@link authenticate} middleware mounted ahead of the requests
 * router already rejects unauthenticated callers with 401, so no per-route role
 * guard is needed; `req.currentUser` is always present here and supplies the
 * `raised_by` identity (never trusted from the body).
 *
 * ── What the handler does ────────────────────────────────────────────────────
 * It validates the request-envelope shape (taskId, title, optional jira/dates,
 * and the entered `fieldValues`) and delegates to the injected
 * {@link RequestCreateStore}, which — in one transaction — pins the task's
 * current version, validates the entered values against that version, assigns a
 * unique reference, sets status NEW, persists the field values, writes audit
 * rows and records the raiser's last-seen (R2.14, R3, R17, R5.2).
 *
 * The store's field-level validation surfaces as the uniform
 * `MANDATORY_FIELD` / `VALIDATION_FAILED` envelope; an unknown task is a 404;
 * a value for a field outside the task's version is `VALIDATION_FAILED` (400).
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 * The handler depends on the narrow {@link RequestCreateStore} so it unit-tests
 * with an in-memory fake (no database). Production wiring uses
 * {@link DbRequestCreateStore}.
 */

/** The public JSON view of a created request (camelCase, ISO dates). */
export interface CreatedRequestJson {
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

/** Serialise a store {@link CreatedRequestRow} into its public view. */
export function serializeCreatedRequest(row: CreatedRequestRow): CreatedRequestJson {
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

/**
 * Normalise an optional string field from the body: `undefined`/`null`/blank →
 * null; a non-empty string → trimmed; anything else → `VALIDATION_FAILED`.
 */
function readOptionalString(raw: unknown, field: string): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  if (typeof raw !== 'string') {
    throw errors.validationFailed(`${field} must be a string.`, { field });
  }
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Normalise one entry of the `fieldValues` array. Returns a
 * {@link SubmittedFieldValue} or throws `VALIDATION_FAILED` when the entry is
 * not a well-formed `{ taskFieldId, value }` object. The value is kept as a raw
 * string (or null for an omitted optional) — TYPE validation is the store's job
 * against the pinned version's field definitions (R3).
 */
function readFieldValue(raw: unknown): SubmittedFieldValue {
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
 * Parse and validate the create-request body ENVELOPE (R2.14): `taskId`
 * (positive integer) and `title` (non-blank) are required; `jiraNumber`,
 * `estimatedStartDate`, `actualStartDate` are optional; `fieldValues` is an
 * array of `{ taskFieldId, value }`. Bad shape → `VALIDATION_FAILED` (400).
 * Per-field TYPE/mandatory validation is deferred to the store, which knows the
 * pinned version's field definitions.
 */
export function readCreateRequestBody(body: unknown): CreateRequestInput {
  if (typeof body !== 'object' || body === null) {
    throw errors.validationFailed('A JSON body is required.', { field: 'body' });
  }
  const record = body as Record<string, unknown>;

  const taskId = toPositiveInt(record['taskId']);
  if (taskId === null) {
    throw errors.validationFailed('A valid taskId is required.', { field: 'taskId' });
  }

  const rawTitle = record['title'];
  if (typeof rawTitle !== 'string' || rawTitle.trim() === '') {
    throw errors.validationFailed('A non-empty title is required.', { field: 'title' });
  }
  const title = rawTitle.trim();

  const jiraNumber = readOptionalString(record['jiraNumber'], 'jiraNumber');
  const estimatedStartDate = readOptionalString(
    record['estimatedStartDate'],
    'estimatedStartDate',
  );
  const actualStartDate = readOptionalString(record['actualStartDate'], 'actualStartDate');

  const rawFieldValues = record['fieldValues'];
  const fieldValues: SubmittedFieldValue[] = [];
  if (rawFieldValues !== undefined) {
    if (!Array.isArray(rawFieldValues)) {
      throw errors.validationFailed('fieldValues must be an array.', {
        field: 'fieldValues',
      });
    }
    const seen = new Set<number>();
    for (const entry of rawFieldValues) {
      const value = readFieldValue(entry);
      // Reject duplicate task_field ids in one submission (the DB has a
      // unique(request,field) constraint; catch it early with a clean 400).
      if (seen.has(value.taskFieldId)) {
        throw errors.validationFailed('Duplicate taskFieldId in fieldValues.', {
          field: 'fieldValues',
          taskFieldId: value.taskFieldId,
        });
      }
      seen.add(value.taskFieldId);
      fieldValues.push(value);
    }
  }

  return { taskId, title, jiraNumber, estimatedStartDate, actualStartDate, fieldValues };
}

/** Read the authenticated raiser's id (authenticate guarantees `currentUser`). */
function raiserId(req: { currentUser?: { id: number } }): number {
  const user = req.currentUser;
  if (!user) {
    // Defensive: authenticate runs upstream, so this is unreachable.
    throw ApiError.of('FORBIDDEN', 'Authentication required', undefined, 401);
  }
  return user.id;
}

/**
 * `POST /requests` — create a request from the New workflow (R2.14). The store
 * is injected for testability; production uses {@link DbRequestCreateStore}.
 */
export function createCreateRequestHandler(store: RequestCreateStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const input = readCreateRequestBody(req.body);
      try {
        const row = await store.create(input, raiserId(req));
        res.status(201).json(serializeCreatedRequest(row));
      } catch (err) {
        if (err instanceof TaskNotFoundError) {
          throw ApiError.of('NOT_FOUND', 'Task not found.', { taskId: err.taskId });
        }
        if (err instanceof UnknownFieldError) {
          throw errors.validationFailed(
            'A submitted value does not belong to the task version.',
            { taskFieldId: err.taskFieldId },
          );
        }
        throw err;
      }
    })().catch(next);
  };
}

/**
 * Register the create-request route on a router (mounted at `/api`). Attached
 * to the passed-in router so it shares the requests router's `/requests`
 * prefix. The store is injected for testability; production uses
 * {@link DbRequestCreateStore}.
 */
export function registerCreateRequestRoute(
  router: Router,
  store: RequestCreateStore,
): Router {
  router.post('/requests', createCreateRequestHandler(store));
  return router;
}

/** A standalone create-request router (used by tests and for isolated wiring). */
export function createRequestCreateRouter(store: RequestCreateStore): Router {
  return registerCreateRequestRoute(Router(), store);
}
