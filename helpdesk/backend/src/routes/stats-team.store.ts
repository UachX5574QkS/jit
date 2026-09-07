import { many, type Queryable, type SqlParam } from '../db/query.js';
import { pool } from '../db/pool.js';
import { STATUSES, type Status } from '../status/index.js';
import {
  resolveDownwardHierarchy,
  DbManagerGraphLoader,
  type ManagerGraphLoader,
} from '../hierarchy/index.js';

/**
 * Data-access layer for `GET /api/stats/team` — the Team Statistics dashboard
 * (design: "Statistics" — `GET /api/stats/team` — hierarchy-scoped; R11, R19).
 *
 * ── What R11 asks for ────────────────────────────────────────────────────────
 * Team Statistics presents the SAME four datasets as User Statistics (task 8.1,
 * R10) — status-by-month in the viewer's timezone, a type-count pie, a
 * time-by-type pie, and a per-task-type summary table with the average
 * New→Triage and Triage→Complete durations (the latter excluding
 * Rejected/Cancelled) — but scoped to a DIFFERENT population (R11.1):
 *
 *   User Statistics  → the requests the CURRENT USER RAISED.
 *   Team Statistics  → the requests raised by everyone within the current
 *                      user's DOWNWARD management hierarchy (their direct
 *                      reports and, recursively, those reports' reports).
 *
 * R11.2 is explicit that the month/timezone basis and the Rejected/Cancelled
 * exclusion rules are IDENTICAL to User Statistics. So every dataset here is
 * the task-8.1 aggregate with its `raised_by_id = $userId` predicate replaced
 * by `raised_by_id = ANY($hierarchyIds)`, where the hierarchy set is resolved
 * through the SAME manager-hierarchy resolver (task 3.6, R19) that the "My Team"
 * request list (task 6.6) uses — so the area-manager cutoff (R19.2) and cycle
 * guard (R19.4) are reused rather than reimplemented.
 *
 * ── Whose requests are in scope (R11.1, R19) ─────────────────────────────────
 * The hierarchy is the people UNDER the current user — NOT the user themselves
 * (Team Statistics is about the manager's team, matching the "My Team" filter
 * semantics of task 6.6). It is resolved from a {@link ManagerGraph} snapshot:
 *   • start at the current user's direct reports, recurse into their reports
 *     until the frontier empties (R19.1);
 *   • an area-manager report is included but is a boundary — we do not descend
 *     into their sub-tree (R19.2);
 *   • a `visited` guard means resolution always terminates on cyclic data
 *     (R19.4).
 * When the hierarchy is EMPTY (a leaf manager with no reports) every dataset is
 * empty and NO SQL is issued — nothing is raised by "no-one", and we never emit
 * an `IN ()` / `= ANY('{}')` scan.
 *
 * ── Where the New/Triage/Complete moments come from ──────────────────────────
 * Exactly as User Statistics (task 8.1): a request is created in status NEW
 * (R2.14), so the NEW moment is `created_at`; the TRIAGE moment is the earliest
 * `audit_entry` with `new_value = 'TRIAGE'`; the COMPLETE moment is the earliest
 * with `new_value = 'COMPLETE'`. Durations are the differences in seconds. The
 * Triage→Complete average EXCLUDES requests whose current status is REJECTED or
 * CANCELLED (R11.2 → R10.5); New→Triage is not subject to that exclusion.
 *
 * ── Why an interface + a DB implementation ───────────────────────────────────
 * The route handler (stats-team.routes.ts) depends on the narrow
 * {@link TeamStatsStore} interface, never on `pg` directly, so it unit-tests
 * with an in-memory fake — matching the injectable style of the user-stats and
 * request-list stores. The production {@link DbTeamStatsStore} is the only place
 * that talks to Postgres; the hierarchy set is bound as a single array
 * parameter and the IANA timezone / status literals travel as bound
 * placeholders — nothing is interpolated into SQL text (R22.2).
 */

/** The stop states excluded from the Triage→Complete average (R11.2 → R10.5). */
export const TRIAGE_COMPLETE_EXCLUDED = ['REJECTED', 'CANCELLED'] as const;

/** The TRIAGE / COMPLETE status literals the transition moments key off. */
const TRIAGE: Status = 'TRIAGE';
const COMPLETE: Status = 'COMPLETE';

/** The viewer + timezone context the aggregate needs. */
export interface TeamStatsQuery {
  /**
   * The current user's `app_user.id` — the ROOT of the downward hierarchy whose
   * members' requests are aggregated (R11.1, R19). The root itself is NOT
   * included (Team Statistics is about the people under the manager).
   */
  readonly userId: number;
  /**
   * The IANA timezone the "by month" buckets are computed in (R11.2 → R10.1,
   * R18.3): the viewer's browser timezone, falling back to
   * `CurrentUser.timezone`, then to UTC. Bound as a parameter and validated by
   * the route before it reaches the store.
   */
  readonly timezone: string;
}

/** One (month, status) bucket of the status-by-month stacked bar (R11 → R10.1). */
export interface StatusMonthBucket {
  /** The month the request's created_at falls into IN THE VIEWER'S TIMEZONE, `YYYY-MM`. */
  readonly month: string;
  /** The request status for this bucket. */
  readonly status: Status;
  /** How many hierarchy requests fall in this (month, status) bucket. */
  readonly count: number;
}

/** One slice of the type-count pie (R11 → R10.2). */
export interface TypeCountSlice {
  readonly taskId: number;
  readonly taskName: string;
  /** How many hierarchy requests are of this task type. */
  readonly count: number;
}

/** One slice of the time-by-type pie (R11 → R10.3). */
export interface TypeTimeSlice {
  readonly taskId: number;
  readonly taskName: string;
  /** Total recorded time-slice minutes across the hierarchy's requests of this type. */
  readonly totalMinutes: number;
}

/**
 * One row of the summary table (R11 → R10.4, R10.5) — one per task type the
 * hierarchy has raised a request of.
 */
export interface TypeSummaryRow {
  readonly taskId: number;
  readonly taskName: string;
  /** Number of hierarchy requests of this type (R10.4). */
  readonly requestCount: number;
  /**
   * Count of hierarchy requests of this type per status (R10.4). Every status
   * is present; statuses with no requests are `0` so the shape is stable.
   */
  readonly countByStatus: Readonly<Record<Status, number>>;
  /**
   * Average time from New (created_at) to the first Triage, in seconds, over
   * this type's requests that reached Triage (R10.4). `null` when none reached
   * Triage.
   */
  readonly avgNewToTriageSeconds: number | null;
  /**
   * Average lifespan from the first Triage to Complete, in seconds, over this
   * type's requests that reached Complete, EXCLUDING Rejected/Cancelled (R10.4,
   * R10.5). `null` when none qualify.
   */
  readonly avgTriageToCompleteSeconds: number | null;
}

/** The full Team Statistics payload the store returns. */
export interface TeamStatsView {
  readonly statusByMonth: StatusMonthBucket[];
  readonly typeCounts: TypeCountSlice[];
  readonly timeByType: TypeTimeSlice[];
  readonly summary: TypeSummaryRow[];
}

/** The narrow contract the route handler depends on. */
export interface TeamStatsStore {
  /**
   * Compute the four Team-Statistics datasets for the requests raised by
   * everyone in `query.userId`'s downward hierarchy, with month buckets in
   * `query.timezone` (R11, R19, R18.3). An empty hierarchy yields empty
   * datasets.
   */
  getTeamStats(query: TeamStatsQuery): Promise<TeamStatsView>;
}

// ── Pure helpers (unit-tested without a database) ───────────────────────────────

/** A zeroed count-by-status map with every lifecycle status present. */
export function zeroCountByStatus(): Record<Status, number> {
  const out = {} as Record<Status, number>;
  for (const s of STATUSES) {
    out[s] = 0;
  }
  return out;
}

/**
 * The average of a list of non-null durations, or `null` when the list is
 * empty. Kept pure so the "exclude Rejected/Cancelled → null when none qualify"
 * behaviour is unit-testable in isolation (R10.5).
 */
export function averageOrNull(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const total = values.reduce((acc, v) => acc + v, 0);
  return total / values.length;
}

/**
 * True when a request's FINAL status excludes it from the Triage→Complete
 * average (R11.2 → R10.5): REJECTED or CANCELLED. Pure so the exclusion rule is
 * unit-testable directly.
 */
export function isTriageCompleteExcluded(status: string): boolean {
  return (TRIAGE_COMPLETE_EXCLUDED as readonly string[]).includes(status);
}

/** An empty Team Statistics view (a leaf manager with no reports, R11.1/R19). */
export function emptyTeamStatsView(): TeamStatsView {
  return { statusByMonth: [], typeCounts: [], timeByType: [], summary: [] };
}

// ── DB row shapes ───────────────────────────────────────────────────────────────

interface StatusMonthDbRow {
  month: string;
  status: string;
  count: string | number;
}

interface TypeCountDbRow {
  task_id: string | number;
  task_name: string;
  count: string | number;
}

interface TypeTimeDbRow {
  task_id: string | number;
  task_name: string;
  total_minutes: string | number;
}

interface TypeStatusCountDbRow {
  task_id: string | number;
  task_name: string;
  status: string;
  count: string | number;
}

interface TypeDurationDbRow {
  task_id: string | number;
  task_name: string;
  avg_new_to_triage_seconds: string | number | null;
  avg_triage_to_complete_seconds: string | number | null;
}

/**
 * Postgres-backed {@link TeamStatsStore}. All SQL is parameterised and
 * read-only. The downward hierarchy set is resolved through the injected
 * {@link ManagerGraphLoader} + the pure {@link resolveDownwardHierarchy} (so the
 * area-manager cutoff and cycle guard of R19 are reused, not reimplemented) and
 * bound as a single array parameter (`raised_by_id = ANY($1)`). The IANA
 * timezone and the TRIAGE/COMPLETE/excluded status literals are bound too;
 * nothing is interpolated into SQL text (R22.2). Month bucketing rebases
 * `created_at` into the viewer's timezone with `AT TIME ZONE` before truncating
 * to the month (R11.2 → R10.1, R18.3). The `db` and `graphLoader` seams default
 * to production wiring; tests inject fakes.
 */
export class DbTeamStatsStore implements TeamStatsStore {
  constructor(
    private readonly db: Queryable = pool,
    private readonly graphLoader: ManagerGraphLoader = new DbManagerGraphLoader(),
  ) {}

  async getTeamStats(query: TeamStatsQuery): Promise<TeamStatsView> {
    const { userId, timezone } = query;

    // Resolve the downward hierarchy (R11.1, R19). The root (the current user)
    // is NOT part of "their team". An empty set short-circuits to empty
    // datasets so we never issue an `= ANY('{}')` scan.
    const graph = await this.graphLoader.load();
    const memberIds = [...resolveDownwardHierarchy(userId, graph)];
    if (memberIds.length === 0) {
      return emptyTeamStatsView();
    }

    const [statusByMonth, typeCounts, timeByType, summary] = await Promise.all([
      this.statusByMonth(memberIds, timezone),
      this.typeCounts(memberIds),
      this.timeByType(memberIds),
      this.summary(memberIds),
    ]);

    return { statusByMonth, typeCounts, timeByType, summary };
  }

  /**
   * Status-by-month (R11.2 → R10.1, R18.3). The month is `created_at` rebased
   * into the viewer's timezone (`AT TIME ZONE $2`) then truncated to the month
   * and formatted `YYYY-MM`. Grouped by (month, status), counted, ordered so
   * the stacked bar reads chronologically. The hierarchy set ($1) and the
   * timezone ($2) are BOUND, never interpolated.
   */
  private async statusByMonth(
    memberIds: number[],
    timezone: string,
  ): Promise<StatusMonthBucket[]> {
    const rows = await many<StatusMonthDbRow>(
      `SELECT to_char(
                date_trunc('month', (r.created_at AT TIME ZONE $2)),
                'YYYY-MM'
              )                         AS month,
              r.status::text            AS status,
              COUNT(*)                  AS count
         FROM request r
        WHERE r.raised_by_id = ANY($1)
        GROUP BY 1, r.status
        ORDER BY 1, r.status`,
      [memberIds, timezone] as SqlParam[],
      this.db,
    );
    return rows.map((row) => ({
      month: row.month,
      status: row.status as Status,
      count: Number(row.count),
    }));
  }

  /** Type-count pie (R11 → R10.2): hierarchy requests grouped by task type. */
  private async typeCounts(memberIds: number[]): Promise<TypeCountSlice[]> {
    const rows = await many<TypeCountDbRow>(
      `SELECT t.id            AS task_id,
              t.name          AS task_name,
              COUNT(*)        AS count
         FROM request r
         JOIN task_version tv ON tv.id = r.task_version_id
         JOIN task t          ON t.id = tv.task_id
        WHERE r.raised_by_id = ANY($1)
        GROUP BY t.id, t.name
        ORDER BY count DESC, t.name`,
      [memberIds] as SqlParam[],
      this.db,
    );
    return rows.map((row) => ({
      taskId: Number(row.task_id),
      taskName: row.task_name,
      count: Number(row.count),
    }));
  }

  /**
   * Time-by-type pie (R11 → R10.3): total recorded slice minutes across the
   * hierarchy's requests, grouped by task type. A LEFT JOIN keeps a type with
   * requests but no recorded slices at `0` rather than dropping it.
   */
  private async timeByType(memberIds: number[]): Promise<TypeTimeSlice[]> {
    const rows = await many<TypeTimeDbRow>(
      `SELECT t.id                                   AS task_id,
              t.name                                 AS task_name,
              COALESCE(SUM(ts.duration_minutes), 0)  AS total_minutes
         FROM request r
         JOIN task_version tv    ON tv.id = r.task_version_id
         JOIN task t             ON t.id = tv.task_id
         LEFT JOIN time_slice ts ON ts.request_id = r.id
        WHERE r.raised_by_id = ANY($1)
        GROUP BY t.id, t.name
        ORDER BY total_minutes DESC, t.name`,
      [memberIds] as SqlParam[],
      this.db,
    );
    return rows.map((row) => ({
      taskId: Number(row.task_id),
      taskName: row.task_name,
      totalMinutes: Number(row.total_minutes),
    }));
  }

  /**
   * Summary table (R11 → R10.4, R10.5). Assembled from two parameterised
   * aggregates joined per task type:
   *   • per-(type, status) counts — the request count and count-by-status;
   *   • per-type average durations — New→Triage over requests that reached
   *     Triage, and Triage→Complete over requests that reached Complete and are
   *     NOT Rejected/Cancelled (R10.5).
   * Both are keyed on the task type across all its versions (R16.4).
   */
  private async summary(memberIds: number[]): Promise<TypeSummaryRow[]> {
    const [statusCounts, durations] = await Promise.all([
      this.summaryStatusCounts(memberIds),
      this.summaryDurations(memberIds),
    ]);

    // Merge the two aggregates by task id. The status-count query has a row for
    // every task type the hierarchy has raised (it groups by type), so it is
    // the authoritative set of summary rows; durations attach where present.
    const byTask = new Map<number, TypeSummaryRow>();
    const nameByTask = new Map<number, string>();

    for (const row of statusCounts) {
      const taskId = Number(row.task_id);
      nameByTask.set(taskId, row.task_name);
      let entry = byTask.get(taskId);
      if (!entry) {
        entry = {
          taskId,
          taskName: row.task_name,
          requestCount: 0,
          countByStatus: zeroCountByStatus(),
          avgNewToTriageSeconds: null,
          avgTriageToCompleteSeconds: null,
        };
        byTask.set(taskId, entry);
      }
      const count = Number(row.count);
      const mutable = entry.countByStatus as Record<Status, number>;
      mutable[row.status as Status] = count;
      (entry as { requestCount: number }).requestCount += count;
    }

    for (const row of durations) {
      const taskId = Number(row.task_id);
      let entry = byTask.get(taskId);
      if (!entry) {
        // Defensive: a duration row without a status-count row should not
        // happen (every request has a status), but attach it cleanly if so.
        entry = {
          taskId,
          taskName: row.task_name ?? nameByTask.get(taskId) ?? '',
          requestCount: 0,
          countByStatus: zeroCountByStatus(),
          avgNewToTriageSeconds: null,
          avgTriageToCompleteSeconds: null,
        };
        byTask.set(taskId, entry);
      }
      (entry as { avgNewToTriageSeconds: number | null }).avgNewToTriageSeconds =
        row.avg_new_to_triage_seconds == null
          ? null
          : Number(row.avg_new_to_triage_seconds);
      (entry as {
        avgTriageToCompleteSeconds: number | null;
      }).avgTriageToCompleteSeconds =
        row.avg_triage_to_complete_seconds == null
          ? null
          : Number(row.avg_triage_to_complete_seconds);
    }

    return [...byTask.values()].sort((a, b) => {
      if (b.requestCount !== a.requestCount) {
        return b.requestCount - a.requestCount;
      }
      return a.taskName.localeCompare(b.taskName);
    });
  }

  /** Per-(task type, status) counts for the hierarchy's requests (R10.4). */
  private async summaryStatusCounts(
    memberIds: number[],
  ): Promise<TypeStatusCountDbRow[]> {
    return many<TypeStatusCountDbRow>(
      `SELECT t.id            AS task_id,
              t.name          AS task_name,
              r.status::text  AS status,
              COUNT(*)        AS count
         FROM request r
         JOIN task_version tv ON tv.id = r.task_version_id
         JOIN task t          ON t.id = tv.task_id
        WHERE r.raised_by_id = ANY($1)
        GROUP BY t.id, t.name, r.status`,
      [memberIds] as SqlParam[],
      this.db,
    );
  }

  /**
   * Per-task-type average New→Triage and Triage→Complete durations (R10.4,
   * R10.5), in seconds.
   *
   * The transition moments come from `audit_entry` status changes:
   *   • `triage_at`   = MIN(changed_at) where new_value = TRIAGE ($2);
   *   • `complete_at` = MIN(changed_at) where new_value = COMPLETE ($3).
   * New→Triage = triage_at − created_at, averaged over requests that reached
   * Triage. Triage→Complete = complete_at − triage_at, averaged over requests
   * that reached BOTH and whose current status is NOT Rejected/Cancelled — the
   * exclusion is applied by binding those two statuses as an array and requiring
   * `r.status <> ALL(...)` (R10.5). Every status literal is bound, never
   * interpolated (R22.2). Durations use EXTRACT(EPOCH FROM …) → seconds. The
   * hierarchy set is bound as $1.
   */
  private async summaryDurations(memberIds: number[]): Promise<TypeDurationDbRow[]> {
    return many<TypeDurationDbRow>(
      `WITH moments AS (
         SELECT r.id             AS request_id,
                tv.task_id       AS task_id,
                r.status::text   AS status,
                r.created_at     AS created_at,
                (SELECT MIN(ae.changed_at)
                   FROM audit_entry ae
                  WHERE ae.entity_type = 'request'
                    AND ae.entity_id = r.id
                    AND ae.field_name = 'status'
                    AND ae.new_value = $2) AS triage_at,
                (SELECT MIN(ae.changed_at)
                   FROM audit_entry ae
                  WHERE ae.entity_type = 'request'
                    AND ae.entity_id = r.id
                    AND ae.field_name = 'status'
                    AND ae.new_value = $3) AS complete_at
           FROM request r
           JOIN task_version tv ON tv.id = r.task_version_id
          WHERE r.raised_by_id = ANY($1)
       )
       SELECT t.id   AS task_id,
              t.name AS task_name,
              AVG(EXTRACT(EPOCH FROM (m.triage_at - m.created_at)))
                FILTER (WHERE m.triage_at IS NOT NULL)
                     AS avg_new_to_triage_seconds,
              AVG(EXTRACT(EPOCH FROM (m.complete_at - m.triage_at)))
                FILTER (
                  WHERE m.complete_at IS NOT NULL
                    AND m.triage_at IS NOT NULL
                    AND m.status <> ALL($4::text[])
                )    AS avg_triage_to_complete_seconds
         FROM moments m
         JOIN task t ON t.id = m.task_id
        GROUP BY t.id, t.name`,
      [
        memberIds,
        TRIAGE,
        COMPLETE,
        [...TRIAGE_COMPLETE_EXCLUDED],
      ] as SqlParam[],
      this.db,
    );
  }
}
