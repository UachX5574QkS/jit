import { one, type Queryable } from '../db/query.js';
import { pool } from '../db/pool.js';

/**
 * Data-access layer for `GET /api/tasks/{taskId}/estimated-effort` — the
 * type-level Estimated Effort average (design: "Requests (user side)" —
 * `GET /api/tasks/{taskId}/estimated-effort` — type-level average; R4.7).
 *
 * ── What R4.7 computes ───────────────────────────────────────────────────────
 * Estimated Effort for a TASK TYPE is defined (R4.7) as:
 *
 *     SUM(all recorded time_slice durations across that task type's COMPLETE
 *         requests)
 *     ─────────────────────────────────────────────────────────────────────────
 *     COUNT(that task type's COMPLETE requests)
 *
 * i.e. the average total effort recorded on a COMPLETE request of that type.
 * Both halves of the ratio are scoped to COMPLETE requests only:
 *   • the numerator sums `time_slice.duration_minutes` for slices belonging to
 *     COMPLETE requests of the type (slices on non-complete requests never
 *     count — see the tests); and
 *   • the denominator counts the COMPLETE requests of the type.
 *
 * ── "Task type" = the task, across all its versions (R16.4) ──────────────────
 * A request pins a specific `task_version` (R16.4), and `task_version.task_id`
 * identifies the TASK — the "task type". Editing a task creates a new version,
 * so a single task type spans several `task_version` rows. The aggregate is
 * therefore taken over EVERY version of the task: we join
 * `request → task_version` and filter on `task_version.task_id = :taskId`, which
 * folds all versions of the type together.
 *
 * ── The zero-completed case ──────────────────────────────────────────────────
 * When a task type has NO complete requests the denominator is zero, so there
 * is no meaningful average. Rather than divide by zero, the store returns
 * `completedCount = 0`, `totalSliceMinutes = 0`, and `estimatedEffortMinutes =
 * null` — the "no estimate yet" signal the Requests screen renders as blank
 * (R4.5). A task type with complete requests but no recorded slices yields a
 * clean `0` average (sum 0 ÷ count > 0), distinct from the null case.
 *
 * ── Why an interface + a DB implementation ───────────────────────────────────
 * The route handler (requests-estimated-effort.routes.ts) depends on this
 * narrow {@link EstimatedEffortStore} interface, never on `pg` directly, so it
 * unit-tests with an in-memory fake — matching the injectable style used by the
 * request-list, request-detail and workflow-support stores. The production
 * {@link DbEstimatedEffortStore} is the only place that talks to Postgres, and
 * it does so exclusively through the parameterised data-access layer
 * (`db/query.ts`): the task id travels as a bound placeholder, nothing is
 * interpolated into SQL text (R22.2). Available to any authenticated user.
 */

/** The COMPLETE status a request must hold to count toward the average (R4.7, R9.3). */
const COMPLETE_STATUS = 'COMPLETE';

/**
 * The type-level Estimated Effort result (camelCase; R4.9). `estimatedEffortMinutes`
 * is the ratio SUM(slice minutes) ÷ COUNT(complete requests), or `null` when the
 * type has no complete requests.
 */
export interface EstimatedEffortView {
  /** The task ("task type") the estimate is for. */
  readonly taskId: number;
  /** How many COMPLETE requests of this type were counted (the denominator). */
  readonly completedCount: number;
  /** Total recorded slice minutes across those complete requests (the numerator). */
  readonly totalSliceMinutes: number;
  /**
   * The average effort in minutes — `totalSliceMinutes / completedCount` — or
   * `null` when `completedCount` is 0 (no complete requests → no estimate).
   */
  readonly estimatedEffortMinutes: number | null;
}

/** Raised when a task id does not exist. Mapped to 404 by the route layer. */
export class TaskNotFoundError extends Error {
  constructor(readonly taskId: number) {
    super(`Task ${taskId} not found`);
    this.name = 'TaskNotFoundError';
  }
}

/** The narrow contract the route handler depends on. */
export interface EstimatedEffortStore {
  /**
   * Compute the Estimated Effort for the task type identified by `taskId`
   * (R4.7): the SUM of recorded `time_slice` durations across the type's
   * COMPLETE requests divided by the COUNT of those complete requests,
   * aggregated across ALL versions of the task (R16.4). Returns a null estimate
   * cleanly when there are no complete requests. Throws {@link TaskNotFoundError}
   * when the task does not exist.
   */
  getEstimatedEffort(taskId: number): Promise<EstimatedEffortView>;
}

// ── DB row shapes ─────────────────────────────────────────────────────────────

/** Existence probe for the task id (so an unknown task → 404, not a null estimate). */
interface TaskExistsDbRow {
  id: string | number;
}

/**
 * The aggregate row: `completed_count` COMPLETE requests of the type, and
 * `total_slice_minutes` the summed slice duration across them. COUNT never
 * returns NULL; SUM over no rows returns NULL, coalesced to 0 in SQL.
 */
interface EstimatedEffortDbRow {
  completed_count: string | number;
  total_slice_minutes: string | number;
}

/**
 * Postgres-backed {@link EstimatedEffortStore}. All SQL is parameterised and
 * read-only. The `db` seam defaults to the shared pool; tests inject a fake.
 */
export class DbEstimatedEffortStore implements EstimatedEffortStore {
  constructor(private readonly db: Queryable = pool) {}

  async getEstimatedEffort(taskId: number): Promise<EstimatedEffortView> {
    // Confirm the task exists first so an unknown task surfaces as 404 rather
    // than a (misleading) null estimate for a type that isn't there.
    const task = await one<TaskExistsDbRow>(
      `SELECT id FROM task WHERE id = $1`,
      [taskId],
      this.db,
    );
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }

    // Numerator and denominator in one bound query, both scoped to the type's
    // COMPLETE requests across every version (R4.7, R16.4):
    //   • the denominator counts DISTINCT complete requests of the type;
    //   • the numerator sums slice minutes for slices on those same requests,
    //     via a LEFT JOIN so a complete request with no slices still counts in
    //     the denominator while contributing 0 to the numerator.
    // The status literal is a code-controlled constant (never user input) bound
    // as a parameter; the task id is bound as $1 — nothing is interpolated (R22.2).
    const row = await one<EstimatedEffortDbRow>(
      `SELECT COUNT(DISTINCT r.id)                         AS completed_count,
              COALESCE(SUM(ts.duration_minutes), 0)        AS total_slice_minutes
         FROM request r
         JOIN task_version tv ON tv.id = r.task_version_id
         LEFT JOIN time_slice ts ON ts.request_id = r.id
        WHERE tv.task_id = $1
          AND r.status = $2::request_status`,
      [taskId, COMPLETE_STATUS],
      this.db,
    );

    const completedCount = Number(row?.completed_count ?? 0);
    const totalSliceMinutes = Number(row?.total_slice_minutes ?? 0);
    const estimatedEffortMinutes =
      completedCount === 0 ? null : totalSliceMinutes / completedCount;

    return {
      taskId,
      completedCount,
      totalSliceMinutes,
      estimatedEffortMinutes,
    };
  }
}
