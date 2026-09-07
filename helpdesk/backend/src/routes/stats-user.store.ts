import { many, type Queryable, type SqlParam } from '../db/query.js';
import { pool } from '../db/pool.js';
import { STATUSES, type Status } from '../status/index.js';

/**
 * Data-access layer for `GET /api/stats/user` — the User Statistics dashboard
 * (design: "Statistics" — `GET /api/stats/user` — charts + summary table for
 * the current user; R10, R18.3).
 *
 * ── What R10 asks for ────────────────────────────────────────────────────────
 * User Statistics is entirely scoped to the requests the CURRENT USER RAISED
 * (`request.raised_by_id = :userId`). It produces four things:
 *
 *   1. Status-by-month (R10.1) — a stacked bar: the count of the user's
 *      requests by status, broken down by month. The month a request falls into
 *      is decided by its `created_at` REBASED INTO THE VIEWER'S TIMEZONE
 *      (R10.1, R18.3): a request created at 23:30 UTC on the 31st belongs to the
 *      next month for a viewer in a +02:00 zone. Every (month, status) pair the
 *      user has is a bucket; months/statuses with no requests are simply absent.
 *
 *   2. Type pie (R10.2) — the count of the user's requests by task TYPE
 *      (`task_version.task_id` — the type spans every version of a task, R16.4).
 *
 *   3. Time-by-type pie (R10.3) — the total recorded `time_slice` minutes across
 *      the user's requests, broken down by task type (a proportion of the whole;
 *      the frontend renders the proportion, the API returns the minutes).
 *
 *   4. Summary table (R10.4, R10.5) — one row per task type showing: the number
 *      of requests raised, the count per status, the AVERAGE time from New to
 *      Triage, and the AVERAGE lifespan from Triage to a Complete status. The
 *      Triage→Complete average EXCLUDES Rejected and Cancelled requests (R10.5).
 *
 * ── Where the New/Triage/Complete moments come from ──────────────────────────
 * A request's status transitions are recorded column-level in `audit_entry`
 * (`entity_type = 'request'`, `field_name = 'status'`, `old_value` → `new_value`;
 * task 3.4 / the support-mutation store write them this way). So:
 *   • the NEW moment is the request's `created_at` — a request is created in
 *     status NEW (R2.14), which is the baseline the "time from New" is measured
 *     from;
 *   • the TRIAGE moment is the EARLIEST audit entry whose `new_value = 'TRIAGE'`;
 *   • the COMPLETE moment is the audit entry whose `new_value = 'COMPLETE'`.
 * Durations are the differences between those instants, in seconds. A request
 * that never reached TRIAGE contributes to neither average; a request that
 * reached TRIAGE but not COMPLETE contributes only to New→Triage.
 *
 * ── The Rejected/Cancelled exclusion (R10.5) ─────────────────────────────────
 * The Triage→Complete average is a lifespan-to-completion measure, so a request
 * that ended REJECTED or CANCELLED must NOT drag the average down (R10.5): those
 * requests are excluded from that average entirely. (They can only have a
 * Triage→Complete duration at all if they somehow reached COMPLETE, which the
 * lifecycle forbids — but the exclusion is applied explicitly so the rule holds
 * regardless of the data.) The New→Triage average is NOT subject to this
 * exclusion: reaching Triage is meaningful for a request that was later
 * rejected/cancelled.
 *
 * ── Why an interface + a DB implementation ───────────────────────────────────
 * The route handler (stats-user.routes.ts) depends on the narrow
 * {@link UserStatsStore} interface, never on `pg` directly, so it unit-tests
 * with an in-memory fake — matching the injectable style used by the
 * request-list / estimated-effort stores. The production {@link DbUserStatsStore}
 * is the only place that talks to Postgres, and every value (the viewer id, the
 * IANA timezone) travels as a bound placeholder — nothing is interpolated into
 * SQL text (R22.2). Available to any authenticated user; it only ever aggregates
 * the caller's own requests.
 */

/** The stop states excluded from the Triage→Complete average (R10.5). */
export const TRIAGE_COMPLETE_EXCLUDED = ['REJECTED', 'CANCELLED'] as const;

/** The TRIAGE / COMPLETE status literals the transition moments key off. */
const TRIAGE: Status = 'TRIAGE';
const COMPLETE: Status = 'COMPLETE';

/** The viewer + timezone context the aggregate needs. */
export interface UserStatsQuery {
  /** The current user's `app_user.id` — the requests are those they raised. */
  readonly userId: number;
  /**
   * The IANA timezone the "by month" buckets are computed in (R10.1, R18.3):
   * the viewer's browser timezone, falling back to `CurrentUser.timezone`, then
   * to UTC. Bound as a parameter and validated by the route before it reaches
   * the store.
   */
  readonly timezone: string;
}

/** One (month, status) bucket of the status-by-month stacked bar (R10.1). */
export interface StatusMonthBucket {
  /** The month the request's created_at falls into IN THE VIEWER'S TIMEZONE, `YYYY-MM`. */
  readonly month: string;
  /** The request status for this bucket. */
  readonly status: Status;
  /** How many of the user's requests fall in this (month, status) bucket. */
  readonly count: number;
}

/** One slice of the type-count pie (R10.2). */
export interface TypeCountSlice {
  readonly taskId: number;
  readonly taskName: string;
  /** How many of the user's requests are of this task type. */
  readonly count: number;
}

/** One slice of the time-by-type pie (R10.3). */
export interface TypeTimeSlice {
  readonly taskId: number;
  readonly taskName: string;
  /** Total recorded time-slice minutes across the user's requests of this type. */
  readonly totalMinutes: number;
}

/**
 * One row of the summary table (R10.4, R10.5) — one per task type the user has
 * raised a request of.
 */
export interface TypeSummaryRow {
  readonly taskId: number;
  readonly taskName: string;
  /** Number of requests the user raised of this type (R10.4). */
  readonly requestCount: number;
  /**
   * Count of the user's requests of this type per status (R10.4). Every status
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

/** The full User Statistics payload the store returns. */
export interface UserStatsView {
  readonly statusByMonth: StatusMonthBucket[];
  readonly typeCounts: TypeCountSlice[];
  readonly timeByType: TypeTimeSlice[];
  readonly summary: TypeSummaryRow[];
}

/** The narrow contract the route handler depends on. */
export interface UserStatsStore {
  /**
   * Compute the four User-Statistics datasets for the requests raised by
   * `query.userId`, with month buckets in `query.timezone` (R10, R18.3).
   */
  getUserStats(query: UserStatsQuery): Promise<UserStatsView>;
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
 * average (R10.5): REJECTED or CANCELLED. Pure so the exclusion rule is
 * unit-testable directly.
 */
export function isTriageCompleteExcluded(status: string): boolean {
  return (TRIAGE_COMPLETE_EXCLUDED as readonly string[]).includes(status);
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
 * Postgres-backed {@link UserStatsStore}. All SQL is parameterised and
 * read-only; the viewer id (`$1`) and the IANA timezone (`$2`) are the only
 * bound values, plus code-controlled status literals bound as further
 * parameters. Month bucketing rebases `created_at` into the viewer's timezone
 * with `AT TIME ZONE $2` before truncating to the month (R10.1, R18.3). The
 * `db` seam defaults to the shared pool; tests inject a fake.
 */
export class DbUserStatsStore implements UserStatsStore {
  constructor(private readonly db: Queryable = pool) {}

  async getUserStats(query: UserStatsQuery): Promise<UserStatsView> {
    const { userId, timezone } = query;

    const [statusByMonth, typeCounts, timeByType, summary] = await Promise.all([
      this.statusByMonth(userId, timezone),
      this.typeCounts(userId),
      this.timeByType(userId),
      this.summary(userId),
    ]);

    return { statusByMonth, typeCounts, timeByType, summary };
  }

  /**
   * Status-by-month (R10.1, R18.3). The month is `created_at` rebased into the
   * viewer's timezone (`AT TIME ZONE $2`) then truncated to the month and
   * formatted `YYYY-MM`. Grouped by (month, status), counted, ordered so the
   * stacked bar reads chronologically. The timezone is BOUND ($2), never
   * interpolated.
   */
  private async statusByMonth(
    userId: number,
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
        WHERE r.raised_by_id = $1
        GROUP BY 1, r.status
        ORDER BY 1, r.status`,
      [userId, timezone] as SqlParam[],
      this.db,
    );
    return rows.map((row) => ({
      month: row.month,
      status: row.status as Status,
      count: Number(row.count),
    }));
  }

  /** Type-count pie (R10.2): the user's requests grouped by task type. */
  private async typeCounts(userId: number): Promise<TypeCountSlice[]> {
    const rows = await many<TypeCountDbRow>(
      `SELECT t.id            AS task_id,
              t.name          AS task_name,
              COUNT(*)        AS count
         FROM request r
         JOIN task_version tv ON tv.id = r.task_version_id
         JOIN task t          ON t.id = tv.task_id
        WHERE r.raised_by_id = $1
        GROUP BY t.id, t.name
        ORDER BY count DESC, t.name`,
      [userId] as SqlParam[],
      this.db,
    );
    return rows.map((row) => ({
      taskId: Number(row.task_id),
      taskName: row.task_name,
      count: Number(row.count),
    }));
  }

  /**
   * Time-by-type pie (R10.3): total recorded slice minutes across the user's
   * requests, grouped by task type. A LEFT JOIN keeps a type with requests but
   * no recorded slices at `0` rather than dropping it.
   */
  private async timeByType(userId: number): Promise<TypeTimeSlice[]> {
    const rows = await many<TypeTimeDbRow>(
      `SELECT t.id                                   AS task_id,
              t.name                                 AS task_name,
              COALESCE(SUM(ts.duration_minutes), 0)  AS total_minutes
         FROM request r
         JOIN task_version tv    ON tv.id = r.task_version_id
         JOIN task t             ON t.id = tv.task_id
         LEFT JOIN time_slice ts ON ts.request_id = r.id
        WHERE r.raised_by_id = $1
        GROUP BY t.id, t.name
        ORDER BY total_minutes DESC, t.name`,
      [userId] as SqlParam[],
      this.db,
    );
    return rows.map((row) => ({
      taskId: Number(row.task_id),
      taskName: row.task_name,
      totalMinutes: Number(row.total_minutes),
    }));
  }

  /**
   * Summary table (R10.4, R10.5). Assembled from two parameterised aggregates
   * joined per task type:
   *   • per-(type, status) counts — the request count and count-by-status;
   *   • per-type average durations — New→Triage over requests that reached
   *     Triage, and Triage→Complete over requests that reached Complete and are
   *     NOT Rejected/Cancelled (R10.5).
   * Both are keyed on the task type across all its versions (R16.4).
   */
  private async summary(userId: number): Promise<TypeSummaryRow[]> {
    const [statusCounts, durations] = await Promise.all([
      this.summaryStatusCounts(userId),
      this.summaryDurations(userId),
    ]);

    // Merge the two aggregates by task id. The status-count query has a row for
    // every task type the user has raised (it groups by type), so it is the
    // authoritative set of summary rows; durations attach where present.
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

  /** Per-(task type, status) counts for the user's requests (R10.4). */
  private async summaryStatusCounts(
    userId: number,
  ): Promise<TypeStatusCountDbRow[]> {
    return many<TypeStatusCountDbRow>(
      `SELECT t.id            AS task_id,
              t.name          AS task_name,
              r.status::text  AS status,
              COUNT(*)        AS count
         FROM request r
         JOIN task_version tv ON tv.id = r.task_version_id
         JOIN task t          ON t.id = tv.task_id
        WHERE r.raised_by_id = $1
        GROUP BY t.id, t.name, r.status`,
      [userId] as SqlParam[],
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
   * interpolated (R22.2). Durations use EXTRACT(EPOCH FROM …) → seconds.
   */
  private async summaryDurations(userId: number): Promise<TypeDurationDbRow[]> {
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
          WHERE r.raised_by_id = $1
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
        userId,
        TRIAGE,
        COMPLETE,
        [...TRIAGE_COMPLETE_EXCLUDED],
      ] as SqlParam[],
      this.db,
    );
  }
}
