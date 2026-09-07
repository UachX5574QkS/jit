import { Router, type RequestHandler } from 'express';
import { ApiError, errors } from '../middleware/errors.js';
import {
  DbEstimatedEffortStore,
  TaskNotFoundError,
  type EstimatedEffortStore,
  type EstimatedEffortView,
} from './requests-estimated-effort.store.js';

/**
 * `GET /api/tasks/{taskId}/estimated-effort` — the type-level Estimated Effort
 * average (design: "Requests (user side)" —
 * `GET /api/tasks/{taskId}/estimated-effort` — type-level average; R4.7).
 *
 * ── What it returns ──────────────────────────────────────────────────────────
 * Estimated Effort for a TASK TYPE is the SUM of all recorded time-slice
 * durations across that type's COMPLETE requests divided by the number of
 * COMPLETE requests of that type (R4.7), aggregated over ALL versions of the
 * task (a request pins a `task_version`; `task_version.task_id` is the type —
 * R16.4). The response exposes the components alongside the ratio so the
 * Requests screen can render the average (or blank it when null):
 *
 *     { "taskId": 42,
 *       "completedCount": 3,
 *       "totalSliceMinutes": 180,
 *       "estimatedEffortMinutes": 60 }
 *
 * When the type has NO complete requests, `estimatedEffortMinutes` is `null`
 * (with `completedCount` / `totalSliceMinutes` both 0) — the "no estimate yet"
 * signal, returned cleanly rather than dividing by zero.
 *
 * ── Authorisation ────────────────────────────────────────────────────────────
 * Available to any authenticated user (R4.1). The global {@link authenticate}
 * middleware mounted ahead of the requests router already rejects
 * unauthenticated callers with 401; the estimate is a type-level aggregate that
 * leaks no individual request, so no per-route role guard is needed. An unknown
 * task id surfaces as 404 NOT_FOUND.
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 * The handler depends on the narrow {@link EstimatedEffortStore} so it
 * unit-tests with an in-memory fake (no database). Production wiring uses
 * {@link DbEstimatedEffortStore}.
 */

// ── Public JSON view (camelCase; R4.9) ─────────────────────────────────────────

export interface EstimatedEffortJson {
  readonly taskId: number;
  readonly completedCount: number;
  readonly totalSliceMinutes: number;
  readonly estimatedEffortMinutes: number | null;
}

/** Serialise a store {@link EstimatedEffortView} into its public JSON view. */
export function serializeEstimatedEffort(view: EstimatedEffortView): EstimatedEffortJson {
  return {
    taskId: view.taskId,
    completedCount: view.completedCount,
    totalSliceMinutes: view.totalSliceMinutes,
    estimatedEffortMinutes: view.estimatedEffortMinutes,
  };
}

// ── Param parsing ──────────────────────────────────────────────────────────────

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
 * `GET /tasks/:taskId/estimated-effort` — return the task type's Estimated
 * Effort average (R4.7). Unknown task → 404. The store is injected for
 * testability; production uses {@link DbEstimatedEffortStore}.
 */
export function makeGetEstimatedEffortHandler(
  store: EstimatedEffortStore,
): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const taskId = toPositiveInt((req.params as Record<string, unknown>)['taskId']);
      if (taskId === null) {
        throw errors.validationFailed('A valid task id is required.', { field: 'taskId' });
      }
      try {
        const view = await store.getEstimatedEffort(taskId);
        res.status(200).json(serializeEstimatedEffort(view));
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
 * Register the estimated-effort route on a router (mounted at `/api`). Attached
 * to the passed-in router so it shares the requests router's `/tasks` prefix
 * (the requests router owns `/tasks`). The store is injected for testability;
 * production uses {@link DbEstimatedEffortStore}.
 */
export function registerEstimatedEffortRoute(
  router: Router,
  store: EstimatedEffortStore,
): Router {
  router.get('/tasks/:taskId/estimated-effort', makeGetEstimatedEffortHandler(store));
  return router;
}

/** A standalone estimated-effort router (used by tests and for isolated wiring). */
export function createEstimatedEffortRouter(store: EstimatedEffortStore): Router {
  return registerEstimatedEffortRoute(Router(), store);
}
