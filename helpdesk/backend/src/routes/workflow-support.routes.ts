import { Router, type RequestHandler } from 'express';
import { ApiError, errors } from '../middleware/errors.js';
import {
  DbWorkflowSupportStore,
  TaskNotFoundError,
  type ActiveTaskView,
  type CurrentVersionFieldView,
  type CurrentVersionView,
  type OpenTeamView,
  type WorkflowSupportStore,
} from './workflow-support.store.js';

/**
 * New-workflow SUPPORT read endpoints (design: "Workflow support", R2.3,
 * R2.5–2.8, R3.5).
 *
 *   GET /api/teams?open=true                  non-closed teams for Step 1 (R2.3)
 *   GET /api/teams/:id/tasks?active=true      that team's non-retired tasks (R2.3)
 *   GET /api/tasks/:id/current-version        the task's current version, laid
 *                                             out for data entry (R2.5–2.8, R3.5)
 *
 * ── Authorisation ────────────────────────────────────────────────────────────
 * These are authenticated READS available to ANY authenticated user — every
 * user may raise a request, so the "New" workflow (and thus its support reads)
 * is open to the whole authenticated audience (R2.1). The global
 * {@link authenticate} middleware mounted ahead of the requests router already
 * rejects unauthenticated callers with 401, so no per-route role guard is
 * needed here; there is nothing role-specific to gate.
 *
 * ── The `open`/`active` query flags ──────────────────────────────────────────
 * The design documents `?open=true` and `?active=true`. Filtering to non-closed
 * teams and non-retired tasks is the ONLY behaviour these endpoints have — the
 * New workflow must never offer a closed team or retired task (R13.4, R16.6) —
 * so the flags are accepted for contract fidelity but the store always applies
 * the filter regardless of their value. Unknown/omitted flags do not change the
 * result.
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 * Handlers depend on the narrow {@link WorkflowSupportStore} so they unit-test
 * with an in-memory fake (no database). Production wiring uses
 * {@link DbWorkflowSupportStore}.
 */

// ── Public JSON views ─────────────────────────────────────────────────────────

/** Public JSON view of a non-closed team (Step 1 team drop-down). */
export interface OpenTeamJson {
  readonly id: number;
  readonly title: string;
  readonly description: string | null;
}

/** Public JSON view of a non-retired task (Step 1 task selection). */
export interface ActiveTaskJson {
  readonly id: number;
  readonly teamId: number;
  readonly name: string;
}

/** Public JSON view of one merged current-version field (Step 2 data entry). */
export interface CurrentVersionFieldJson {
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
}

/** Public JSON view of a task's current version with its ordered fields. */
export interface CurrentVersionJson {
  readonly taskId: number;
  readonly taskName: string;
  readonly teamId: number;
  readonly versionId: number;
  readonly versionNo: number;
  readonly supportNotes: string | null;
  readonly fields: CurrentVersionFieldJson[];
}

function serializeTeam(team: OpenTeamView): OpenTeamJson {
  return { id: team.id, title: team.title, description: team.description };
}

function serializeTask(task: ActiveTaskView): ActiveTaskJson {
  return { id: task.id, teamId: task.teamId, name: task.name };
}

function serializeField(field: CurrentVersionFieldView): CurrentVersionFieldJson {
  return {
    taskFieldId: field.taskFieldId,
    dataPointId: field.dataPointId,
    fieldOrder: field.fieldOrder,
    name: field.name,
    dataType: field.dataType,
    isMandatory: field.isMandatory,
    description: field.description,
    helpText: field.helpText,
    options: field.options,
    regexpPattern: field.regexpPattern,
  };
}

/** Serialise a store {@link CurrentVersionView} into its public JSON view. */
export function serializeCurrentVersion(version: CurrentVersionView): CurrentVersionJson {
  return {
    taskId: version.taskId,
    taskName: version.taskName,
    teamId: version.teamId,
    versionId: version.versionId,
    versionNo: version.versionNo,
    supportNotes: version.supportNotes,
    fields: version.fields.map(serializeField),
  };
}

// ── Body/param parsing ─────────────────────────────────────────────────────────

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

/** Parse `:id` from the route, throwing `VALIDATION_FAILED` when malformed. */
function readId(req: { params: unknown }, field: string): number {
  const id = toPositiveInt((req.params as Record<string, unknown>)['id']);
  if (id === null) {
    throw errors.validationFailed(`A valid ${field} is required.`, { field: 'id' });
  }
  return id;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

/** `GET /teams?open=true` — list non-closed teams for Step 1 (R2.3). */
export function createListOpenTeamsHandler(store: WorkflowSupportStore): RequestHandler {
  return (_req, res, next) => {
    void (async () => {
      const teams = await store.listOpenTeams();
      res.status(200).json({ teams: teams.map(serializeTeam) });
    })().catch(next);
  };
}

/** `GET /teams/:id/tasks?active=true` — list a team's non-retired tasks (R2.3). */
export function createListActiveTasksHandler(store: WorkflowSupportStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const teamId = readId(req, 'team id');
      const tasks = await store.listActiveTasks(teamId);
      res.status(200).json({ tasks: tasks.map(serializeTask) });
    })().catch(next);
  };
}

/**
 * `GET /tasks/:id/current-version` — the task's current (latest) version laid
 * out for data entry (R2.5–2.8, R3.5, R16.5). Unknown task → 404.
 */
export function createGetCurrentVersionHandler(store: WorkflowSupportStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const taskId = readId(req, 'task id');
      try {
        const version = await store.getCurrentVersion(taskId);
        res.status(200).json(serializeCurrentVersion(version));
      } catch (err) {
        if (err instanceof TaskNotFoundError) {
          throw ApiError.of('NOT_FOUND', 'Task not found.', { taskId: err.taskId });
        }
        throw err;
      }
    })().catch(next);
  };
}

/**
 * Register the workflow-support routes on a router (mounted at `/api`). The
 * store is injected for testability; production uses {@link DbWorkflowSupportStore}.
 *
 * Routes are attached to the passed-in router rather than a fresh one so they
 * can share the requests router's `/teams` and `/tasks` prefixes (design: the
 * requests router owns `/teams` and `/tasks`).
 */
export function registerWorkflowSupportRoutes(
  router: Router,
  store: WorkflowSupportStore,
): Router {
  router.get('/teams', createListOpenTeamsHandler(store));
  router.get('/teams/:id/tasks', createListActiveTasksHandler(store));
  router.get('/tasks/:id/current-version', createGetCurrentVersionHandler(store));
  return router;
}

/** A standalone workflow-support router (used by tests and for isolated wiring). */
export function createWorkflowSupportRouter(store: WorkflowSupportStore): Router {
  return registerWorkflowSupportRoutes(Router(), store);
}

/** Production workflow-support router, wired to the Postgres-backed store. */
export const workflowSupportRouter: Router = createWorkflowSupportRouter(
  new DbWorkflowSupportStore(),
);
