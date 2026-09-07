import { Router, type RequestHandler } from 'express';
import { ApiError, errors } from '../middleware/errors.js';
import { requireTeamLeadership } from '../middleware/authorize.js';
import { leadsTeam } from '../identity/index.js';
import {
  DbTaskLeaderStore,
  RetiredDataPointError,
  TaskNotFoundError,
  type CreateTaskInput,
  type CreateVersionInput,
  type TaskFieldInput,
  type TaskFieldView,
  type TaskLeaderStore,
  type TaskVersionView,
  type TaskView,
} from './task-leader.store.js';

/**
 * Team-Leader task-management endpoints (design: "Administration" —
 * `POST/PATCH /api/team-leader/tasks` — create/new-version tasks; retire;
 * leader-only, R16, R20.4).
 *
 *   POST  /api/team-leader/tasks             create a task + its first version (R16.1, R16.2)
 *   PATCH /api/team-leader/tasks/:id         edit → create a NEW version       (R16.4)
 *   POST  /api/team-leader/tasks/:id/retire  retire the task                   (R16.6, R20.4)
 *
 * ── Authorisation: leader-of-THIS-team ───────────────────────────────────────
 * A team leader may manage tasks ONLY for teams they lead (R16.1). This is the
 * server-side enforcement point; the frontend hiding the Team-Leader tiles is
 * UX only. Two shapes of check are needed because the team is identified
 * differently per route:
 *   - CREATE carries `teamId` in the body, so {@link requireTeamLeadership}
 *     (which reads the body) guards it BEFORE the handler runs. A leader of a
 *     DIFFERENT team (or a non-leader) is rejected with the uniform `FORBIDDEN`
 *     (403) envelope.
 *   - EDIT / RETIRE identify the team indirectly, via the `:id` task. The team
 *     can only be known after loading the task, so those handlers resolve the
 *     owning team through the store and then assert leadership themselves —
 *     404 for an unknown task, 403 when the caller does not lead its team. An
 *     administrator is NOT implicitly a leader here (admin task endpoints do not
 *     exist); leadership is checked precisely.
 *
 * ── Override restrictions (R16.3) ────────────────────────────────────────────
 * Field bodies may set the order, mandatory flag, and override the data point's
 * description/help text (and, for a dropdown, its options), but may NEVER
 * override the data point's `name` or `dataType`. Supplying either is rejected
 * with `VALIDATION_FAILED`. Whether the referenced data points are non-retired
 * (R16.2) is enforced in the store, surfaced here as `VALIDATION_FAILED`.
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 * Handlers depend on the narrow {@link TaskLeaderStore} so they unit-test with
 * an in-memory fake (no database). Production wiring uses {@link
 * DbTaskLeaderStore}.
 */

// ── Public JSON views ─────────────────────────────────────────────────────────

/** The public JSON view of a task field (mirrors {@link TaskFieldView}). */
export interface TaskFieldViewJson {
  readonly id: number;
  readonly dataPointId: number;
  readonly fieldOrder: number;
  readonly isMandatory: boolean;
  readonly descriptionOverride: string | null;
  readonly helpTextOverride: string | null;
  readonly optionsOverride: string[] | null;
}

/** The public JSON view of a task with its current version. */
export interface TaskViewJson {
  readonly id: number;
  readonly teamId: number;
  readonly name: string;
  readonly isRetired: boolean;
  readonly currentVersion: {
    readonly id: number;
    readonly versionNo: number;
    readonly supportNotes: string | null;
    readonly fields: TaskFieldViewJson[];
  };
}

function serializeField(field: TaskFieldView): TaskFieldViewJson {
  return {
    id: field.id,
    dataPointId: field.dataPointId,
    fieldOrder: field.fieldOrder,
    isMandatory: field.isMandatory,
    descriptionOverride: field.descriptionOverride,
    helpTextOverride: field.helpTextOverride,
    optionsOverride: field.optionsOverride,
  };
}

function serializeVersion(version: TaskVersionView): TaskViewJson['currentVersion'] {
  return {
    id: version.id,
    versionNo: version.versionNo,
    supportNotes: version.supportNotes,
    fields: version.fields.map(serializeField),
  };
}

/** Serialise a store {@link TaskView} into its public JSON view. */
export function serializeTask(task: TaskView): TaskViewJson {
  return {
    id: task.id,
    teamId: task.teamId,
    name: task.name,
    isRetired: task.isRetired,
    currentVersion: serializeVersion(task.currentVersion),
  };
}

// ── Body parsing / validation ─────────────────────────────────────────────────

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

/** Parse a non-negative integer (for field order), or `null` when malformed. */
function toNonNegativeInt(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0) {
    return raw;
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n >= 0) {
      return n;
    }
  }
  return null;
}

/** Read an optional override string: absent/null/empty → null; non-string → error. */
function readOptionalOverride(
  record: Record<string, unknown>,
  key: string,
  index: number,
): string | null {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw errors.validationFailed(`${key} must be a string.`, {
      field: `fields[${index}].${key}`,
    });
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Validate one field entry (R16.2, R16.3). Enforces the override restriction:
 * `name` and `dataType` are NOT overridable, so their presence is rejected with
 * `VALIDATION_FAILED`. Requires a positive-integer `dataPointId`, a
 * non-negative `fieldOrder`, a boolean `isMandatory`, and (optionally) a
 * dropdown `optionsOverride` of non-empty strings.
 */
export function readFieldInput(raw: unknown, index: number): TaskFieldInput {
  if (raw === null || typeof raw !== 'object') {
    throw errors.validationFailed('Each field must be an object.', {
      field: `fields[${index}]`,
    });
  }
  const record = raw as Record<string, unknown>;

  // R16.3: name/dataType are NEVER overridable at the task-field level. Reject
  // any attempt to supply them rather than silently ignoring the value.
  for (const forbidden of ['name', 'dataType', 'dataPointName', 'data_type']) {
    if (record[forbidden] !== undefined) {
      throw errors.validationFailed(
        `A task field may not override "${forbidden}" — only the data point's description, help text, and dropdown options are overridable.`,
        { field: `fields[${index}].${forbidden}` },
      );
    }
  }

  const dataPointId = toPositiveInt(record['dataPointId']);
  if (dataPointId === null) {
    throw errors.validationFailed('Each field requires a valid dataPointId.', {
      field: `fields[${index}].dataPointId`,
    });
  }

  const fieldOrder = toNonNegativeInt(record['fieldOrder']);
  if (fieldOrder === null) {
    throw errors.validationFailed('fieldOrder must be a non-negative integer.', {
      field: `fields[${index}].fieldOrder`,
    });
  }

  const rawMandatory = record['isMandatory'];
  if (rawMandatory !== undefined && typeof rawMandatory !== 'boolean') {
    throw errors.validationFailed('isMandatory must be a boolean.', {
      field: `fields[${index}].isMandatory`,
    });
  }
  const isMandatory = rawMandatory === true;

  const descriptionOverride = readOptionalOverride(record, 'descriptionOverride', index);
  const helpTextOverride = readOptionalOverride(record, 'helpTextOverride', index);

  let optionsOverride: string[] | null = null;
  const rawOptions = record['optionsOverride'];
  if (rawOptions !== undefined && rawOptions !== null) {
    if (!Array.isArray(rawOptions) || rawOptions.length === 0) {
      throw errors.validationFailed(
        'optionsOverride must be a non-empty array of strings.',
        { field: `fields[${index}].optionsOverride` },
      );
    }
    const options: string[] = [];
    for (const opt of rawOptions) {
      if (typeof opt !== 'string' || opt.trim() === '') {
        throw errors.validationFailed(
          'optionsOverride must contain only non-empty strings.',
          { field: `fields[${index}].optionsOverride` },
        );
      }
      options.push(opt.trim());
    }
    optionsOverride = options;
  }

  return { dataPointId, fieldOrder, isMandatory, descriptionOverride, helpTextOverride, optionsOverride };
}

/** Validate the `fields` array (may be empty) into {@link TaskFieldInput}s. */
function readFields(raw: unknown): TaskFieldInput[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw errors.validationFailed('fields must be an array.', { field: 'fields' });
  }
  return raw.map((entry, i) => readFieldInput(entry, i));
}

/** Read an optional supportNotes string: absent/null/empty → null. */
function readSupportNotes(record: Record<string, unknown>): string | null {
  const value = record['supportNotes'];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw errors.validationFailed('supportNotes must be a string.', {
      field: 'supportNotes',
    });
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Validate the create-task body (R16.1, R16.2): a positive `teamId`, a non-blank
 * `name`, optional `supportNotes`, and a `fields` array honouring the override
 * restrictions (R16.3).
 */
export function readCreateTaskBody(body: unknown): CreateTaskInput {
  const record = (body ?? {}) as Record<string, unknown>;

  const teamId = toPositiveInt(record['teamId']);
  if (teamId === null) {
    throw errors.validationFailed('A valid teamId is required.', { field: 'teamId' });
  }

  const rawName = record['name'];
  if (typeof rawName !== 'string' || rawName.trim() === '') {
    throw errors.validationFailed('A non-empty task name is required.', {
      field: 'name',
    });
  }

  return {
    teamId,
    name: rawName.trim(),
    supportNotes: readSupportNotes(record),
    fields: readFields(record['fields']),
  };
}

/**
 * Validate the edit body for a NEW version (R16.4): optional `name` (non-blank
 * when present), optional `supportNotes`, and a `fields` array honouring the
 * override restrictions (R16.3).
 */
export function readCreateVersionBody(body: unknown): CreateVersionInput {
  const record = (body ?? {}) as Record<string, unknown>;

  const input: {
    name?: string;
    supportNotes: string | null;
    fields: TaskFieldInput[];
  } = {
    supportNotes: readSupportNotes(record),
    fields: readFields(record['fields']),
  };

  if (record['name'] !== undefined) {
    const rawName = record['name'];
    if (typeof rawName !== 'string' || rawName.trim() === '') {
      throw errors.validationFailed('name must be a non-empty string.', {
        field: 'name',
      });
    }
    input.name = rawName.trim();
  }

  return input;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** Read the authenticated leader's id (authenticate guarantees `currentUser`). */
function actingUserId(req: { currentUser?: { id: number } }): number {
  const user = req.currentUser;
  if (!user) {
    // Defensive: authenticate runs first, so this is unreachable in production.
    throw ApiError.of('FORBIDDEN', 'Authentication required', undefined, 401);
  }
  return user.id;
}

/** Parse `:id` from the route, throwing `VALIDATION_FAILED` when malformed. */
function readTaskId(req: { params: unknown }): number {
  const taskId = toPositiveInt((req.params as Record<string, unknown>)['id']);
  if (taskId === null) {
    throw errors.validationFailed('A valid task id is required.', { field: 'id' });
  }
  return taskId;
}

/** Map store domain errors to the uniform error envelope. */
function mapStoreError(err: unknown): unknown {
  if (err instanceof RetiredDataPointError) {
    return errors.validationFailed(err.message, {
      dataPointId: err.dataPointId,
      reason: err.reason,
    });
  }
  if (err instanceof TaskNotFoundError) {
    return ApiError.of('NOT_FOUND', 'Task not found.', { taskId: err.taskId });
  }
  return err;
}

/**
 * For EDIT/RETIRE: resolve the task's owning team and assert the caller leads
 * it (R16.1). Order matters — a 404 for an unknown task is distinct from a 403
 * for a task the caller cannot manage. Returns nothing; throws otherwise.
 */
async function assertLeadsTaskTeam(
  store: TaskLeaderStore,
  taskId: number,
  req: { currentUser?: { id: number } },
): Promise<void> {
  const teamId = await store.findTeamIdForTask(taskId);
  if (teamId === null) {
    throw ApiError.of('NOT_FOUND', 'Task not found.', { taskId });
  }
  const user = req.currentUser;
  if (!user || !leadsTeam(user as never, teamId)) {
    throw errors.forbidden('Requires leadership of this task\u2019s team.', {
      taskId,
      teamId,
    });
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/** `POST /team-leader/tasks` — create a task + its first version (R16.1, R16.2). */
export function createCreateTaskHandler(store: TaskLeaderStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const input = readCreateTaskBody(req.body);
      try {
        const task = await store.create(input, actingUserId(req));
        res.status(201).json(serializeTask(task));
      } catch (err) {
        throw mapStoreError(err);
      }
    })().catch(next);
  };
}

/**
 * `PATCH /team-leader/tasks/:id` — edit a task by creating a NEW version with a
 * fresh field set (R16.4 — version pinning). Leadership of the task's team is
 * asserted first; prior versions are never mutated.
 */
export function createNewVersionHandler(store: TaskLeaderStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const taskId = readTaskId(req);
      const input = readCreateVersionBody(req.body);
      try {
        await assertLeadsTaskTeam(store, taskId, req);
        const task = await store.createVersion(taskId, input, actingUserId(req));
        res.status(200).json(serializeTask(task));
      } catch (err) {
        throw mapStoreError(err);
      }
    })().catch(next);
  };
}

/**
 * `POST /team-leader/tasks/:id/retire` — retire a task so it can't be chosen for
 * new requests while remaining associated with requests already raised against
 * it (R16.6 / R20.4). Leadership of the task's team is asserted first.
 */
export function createRetireTaskHandler(store: TaskLeaderStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const taskId = readTaskId(req);
      try {
        await assertLeadsTaskTeam(store, taskId, req);
        const task = await store.retire(taskId, actingUserId(req));
        res.status(200).json(serializeTask(task));
      } catch (err) {
        throw mapStoreError(err);
      }
    })().catch(next);
  };
}

/**
 * Build the team-leader task router. CREATE is guarded up front by
 * {@link requireTeamLeadership} keyed on the body `teamId`; EDIT/RETIRE assert
 * leadership inside the handler after resolving the task's team (R16.1). The
 * store is injected for testability; production uses {@link DbTaskLeaderStore}.
 */
export function createTaskLeaderRouter(store: TaskLeaderStore): Router {
  const router = Router();
  router.post('/tasks', requireTeamLeadership('teamId'), createCreateTaskHandler(store));
  router.patch('/tasks/:id', createNewVersionHandler(store));
  router.post('/tasks/:id/retire', createRetireTaskHandler(store));
  return router;
}

/** Production team-leader task router, wired to the Postgres-backed store. */
export const taskLeaderRouter: Router = createTaskLeaderRouter(new DbTaskLeaderStore());
