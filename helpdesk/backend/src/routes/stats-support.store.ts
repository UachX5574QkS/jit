import { many, type Queryable, type SqlParam } from '../db/query.js';
import { pool } from '../db/pool.js';
import { type Status } from '../status/index.js';

/**
 * Data-access layer for `GET /api/stats/support` — the Support Statistics
 * dashboard (design: "Statistics" — `GET /api/stats/support?team=|all` —
 * team-level tables + chart; R12).
 *
 * ── What R12 asks for ────────────────────────────────────────────────────────
 * Support Statistics is a SUPPORT-side view scoped to a support team (or every
 * team the current user is in). Unlike User/Team Statistics (which aggregate the
 * requests a person RAISED), Support Statistics aggregates the requests a team
 * OWNS (`request.team_id`) and breaks the two duration/assignment tables down by
 * the ASSIGNED support member. It presents:
 *
 *   • a team selector plus an "All Teams" option scoping every dataset (R12.1);
 *   • `statusByMonth` — a stacked bar of the number of requests by status,
 *     bucketed by month in the viewer's timezone (R12.2 → R18.3), IDENTICAL in
 *     shape and timezone basis to tasks 8.1/8.2;
 *   • `assignedCounts` — a table whose ROWS are tasks (or "Team - Task" when All
 *     Teams is selected) and whose COLUMNS are the team members, each cell being
 *     the total number of requests assigned to that member REGARDLESS of status
 *     (R12.3);
 *   • `avgAcceptedToComplete` — a second table with the SAME rows and columns
 *     where each cell is the average duration from Accepted to Complete for that
 *     member's requests, EXCLUDING Rejected/Cancelled (R12.4).
 *
 * ── Scope: which teams / which members (R12.1) ───────────────────────────────
 * The route resolves the team drop-down against `CurrentUser.teamsMemberOf`
 * (the support-member convention shared with the Support-queue list, task 7.1):
 *   • a specific team the user is a member of → that ONE team;
 *   • "all" (the default) → EVERY team the user is in.
 * The membership-checked set of team ids arrives here as `teamIds`; a caller can
 * never scope to a team they are not a member of. When the set is empty (a user
 * in no teams) every dataset is empty and NO SQL is issued.
 *
 * The COLUMNS of both tables are the members of the team(s) in scope — the union
 * of `team_member` rows across `teamIds`. A member with no assigned requests is
 * still a column (its cells are 0 / null) so the table shape is stable and every
 * team member is represented (R12.3/R12.4).
 *
 * ── Row identity: Task vs "Team - Task" (R12.3/R12.4) ────────────────────────
 * The two tables share their row/column dimensions. A row is one TASK TYPE
 * (keyed on `task.id`, spanning all its versions, R16.4). When more than one
 * team is in scope ("All Teams") the row label is prefixed with the team title
 * ("Team - Task") so tasks from different teams are distinguishable; with a
 * single team the label is just the task name. The store always returns the
 * team id + title and the task id + name so the route can format the label and
 * the frontend can group as it likes.
 *
 * ── The Accepted→Complete duration (R12.4) ───────────────────────────────────
 * A request is created NEW (R2.14); the ACCEPTED moment is the earliest
 * `audit_entry` status change to ACCEPTED and the COMPLETE moment the earliest
 * to COMPLETE — the SAME audit-entry basis tasks 8.1/8.2 use for New→Triage and
 * Triage→Complete. The average is over requests that reached BOTH moments and
 * whose CURRENT status is NOT Rejected/Cancelled (R12.4). The exclusion statuses
 * and the ACCEPTED/COMPLETE literals are all BOUND, never interpolated (R22.2).
 *
 * ── Why an interface + a DB implementation ───────────────────────────────────
 * The route handler (stats-support.routes.ts) depends on the narrow
 * {@link SupportStatsStore} interface, never on `pg` directly, so it unit-tests
 * with an in-memory fake — matching the injectable style of the user-stats,
 * team-stats and support-list stores. The production {@link DbSupportStatsStore}
 * is the only place that talks to Postgres; the team-id set travels as a single
 * array parameter and the timezone / status literals as bound placeholders —
 * nothing is interpolated into SQL text (R22.2).
 */

/** The stop states excluded from the Accepted→Complete average (R12.4). */
export const ACCEPTED_COMPLETE_EXCLUDED = ['REJECTED', 'CANCELLED'] as const;

/** The ACCEPTED / COMPLETE status literals the transition moments key off. */
const ACCEPTED: Status = 'ACCEPTED';
const COMPLETE: Status = 'COMPLETE';

/** The team scope + timezone context the aggregate needs. */
export interface SupportStatsQuery {
  /**
   * The membership-checked team ids in scope (R12.1), resolved by the route from
   * `CurrentUser.teamsMemberOf` and the team drop-down. Never contains a team
   * the caller is not a member of. May be empty (a user in no teams), in which
   * case the store returns empty datasets and issues no SQL.
   */
  readonly teamIds: ReadonlyArray<number>;
  /**
   * The IANA timezone the "by month" buckets are computed in (R12.2 → R18.3):
   * the viewer's browser timezone, falling back to `CurrentUser.timezone`, then
   * to UTC. Bound as a parameter and validated by the route before it reaches
   * the store.
   */
  readonly timezone: string;
}

/** One (month, status) bucket of the status-by-month stacked bar (R12.2). */
export interface StatusMonthBucket {
  /** The month `created_at` falls into IN THE VIEWER'S TIMEZONE, `YYYY-MM`. */
  readonly month: string;
  /** The request status for this bucket. */
  readonly status: Status;
  /** How many of the team(s)' requests fall in this (month, status) bucket. */
  readonly count: number;
}

/**
 * A table column — one member of the team(s) in scope (R12.3/R12.4). Every
 * member is a column even when they have no assigned requests, so the table
 * shape is stable.
 */
export interface MemberColumn {
  readonly memberId: number;
  readonly memberName: string;
}

/**
 * A row of BOTH tables — one task type in scope (R12.3/R12.4). Keyed on the
 * task id (spanning all versions, R16.4); the team id/title are carried so the
 * route can render "Team - Task" when more than one team is in scope.
 */
export interface TaskRow {
  readonly taskId: number;
  readonly taskName: string;
  readonly teamId: number;
  readonly teamTitle: string;
}

/** One cell of the assigned-count table: (task row, member column) → count. */
export interface AssignedCountCell {
  readonly taskId: number;
  readonly memberId: number;
  /** Requests of this task type assigned to this member, regardless of status. */
  readonly count: number;
}

/**
 * One cell of the Accepted→Complete duration table: (task row, member column) →
 * average seconds, or `null` when no request qualifies (none reached both
 * moments, or all were Rejected/Cancelled, R12.4).
 */
export interface AvgDurationCell {
  readonly taskId: number;
  readonly memberId: number;
  readonly avgAcceptedToCompleteSeconds: number | null;
}

/** The full Support Statistics payload the store returns. */
export interface SupportStatsView {
  /** Stacked-bar buckets (R12.2). */
  readonly statusByMonth: StatusMonthBucket[];
  /** The shared column set for both tables — team members in scope. */
  readonly members: MemberColumn[];
  /** The shared row set for both tables — task types in scope. */
  readonly rows: TaskRow[];
  /** Assigned-count table cells (R12.3). */
  readonly assignedCounts: AssignedCountCell[];
  /** Accepted→Complete average-duration table cells (R12.4). */
  readonly avgAcceptedToComplete: AvgDurationCell[];
}

/** The narrow contract the route handler depends on. */
export interface SupportStatsStore {
  /**
   * Compute the Support-Statistics datasets for the requests owned by the teams
   * in `query.teamIds`, with month buckets in `query.timezone` (R12). An empty
   * team scope yields empty datasets.
   */
  getSupportStats(query: SupportStatsQuery): Promise<SupportStatsView>;
}

// ── Pure helpers (unit-tested without a database) ───────────────────────────────

/** An empty Support Statistics view (a user in no teams, R12.1). */
export function emptySupportStatsView(): SupportStatsView {
  return {
    statusByMonth: [],
    members: [],
    rows: [],
    assignedCounts: [],
    avgAcceptedToComplete: [],
  };
}

/**
 * True when a request's CURRENT status excludes it from the Accepted→Complete
 * average (R12.4): REJECTED or CANCELLED. Pure so the exclusion rule is
 * unit-testable directly.
 */
export function isAcceptedCompleteExcluded(status: string): boolean {
  return (ACCEPTED_COMPLETE_EXCLUDED as readonly string[]).includes(status);
}

// ── DB row shapes ───────────────────────────────────────────────────────────────

interface StatusMonthDbRow {
  month: string;
  status: string;
  count: string | number;
}

interface MemberDbRow {
  member_id: string | number;
  member_name: string;
}

interface TaskRowDbRow {
  task_id: string | number;
  task_name: string;
  team_id: string | number;
  team_title: string;
}

interface AssignedCountDbRow {
  task_id: string | number;
  member_id: string | number;
  count: string | number;
}

interface AvgDurationDbRow {
  task_id: string | number;
  member_id: string | number;
  avg_accepted_to_complete_seconds: string | number | null;
}

/**
 * Postgres-backed {@link SupportStatsStore}. All SQL is parameterised and
 * read-only. The team-id set is bound as a single array parameter
 * (`r.team_id = ANY($1)` / `tm.team_id = ANY($1)`); the IANA timezone and the
 * ACCEPTED/COMPLETE/excluded status literals are bound too — nothing is
 * interpolated into SQL text (R22.2). Month bucketing rebases `created_at` into
 * the viewer's timezone with `AT TIME ZONE` before truncating to the month
 * (R12.2 → R18.3). The `db` seam defaults to production wiring; tests inject a
 * fake.
 */
export class DbSupportStatsStore implements SupportStatsStore {
  constructor(private readonly db: Queryable = pool) {}

  async getSupportStats(query: SupportStatsQuery): Promise<SupportStatsView> {
    const { teamIds, timezone } = query;

    // A user in no teams has nothing to show; short-circuit to empty datasets so
    // we never issue an `= ANY('{}')` scan (R12.1).
    if (teamIds.length === 0) {
      return emptySupportStatsView();
    }

    const scoped = [...teamIds];
    const [statusByMonth, members, rows, assignedCounts, avgAcceptedToComplete] =
      await Promise.all([
        this.statusByMonth(scoped, timezone),
        this.members(scoped),
        this.taskRows(scoped),
        this.assignedCounts(scoped),
        this.avgAcceptedToComplete(scoped),
      ]);

    return { statusByMonth, members, rows, assignedCounts, avgAcceptedToComplete };
  }

  /**
   * Status-by-month (R12.2 → R18.3). The month is `created_at` rebased into the
   * viewer's timezone (`AT TIME ZONE $2`) then truncated to the month and
   * formatted `YYYY-MM`. Grouped by (month, status), counted, ordered so the
   * stacked bar reads chronologically. The team set ($1) and the timezone ($2)
   * are BOUND, never interpolated.
   */
  private async statusByMonth(
    teamIds: number[],
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
        WHERE r.team_id = ANY($1)
        GROUP BY 1, r.status
        ORDER BY 1, r.status`,
      [teamIds, timezone] as SqlParam[],
      this.db,
    );
    return rows.map((row) => ({
      month: row.month,
      status: row.status as Status,
      count: Number(row.count),
    }));
  }

  /**
   * The table columns — the members of the team(s) in scope (R12.3/R12.4). The
   * union of `team_member` across the scoped teams; a member in more than one
   * scoped team appears ONCE. Ordered by display name so the columns are
   * stable. A member with no assigned requests is still a column.
   */
  private async members(teamIds: number[]): Promise<MemberColumn[]> {
    const rows = await many<MemberDbRow>(
      `SELECT DISTINCT u.id                              AS member_id,
              u.first_name || ' ' || u.surname           AS member_name
         FROM team_member tm
         JOIN app_user u ON u.id = tm.user_id
        WHERE tm.team_id = ANY($1)
        ORDER BY member_name, member_id`,
      [teamIds] as SqlParam[],
      this.db,
    );
    return rows.map((row) => ({
      memberId: Number(row.member_id),
      memberName: row.member_name,
    }));
  }

  /**
   * The table rows — the task types owned by the team(s) in scope (R12.3/R12.4).
   * Every non-retired-or-retired task belonging to a scoped team is a row (a row
   * with no assigned requests still appears so the table shape is stable). The
   * team id/title travel so the route can render "Team - Task" when more than
   * one team is in scope. Ordered by team then task name.
   */
  private async taskRows(teamIds: number[]): Promise<TaskRow[]> {
    const rows = await many<TaskRowDbRow>(
      `SELECT t.id      AS task_id,
              t.name    AS task_name,
              tm.id     AS team_id,
              tm.title  AS team_title
         FROM task t
         JOIN team tm ON tm.id = t.team_id
        WHERE t.team_id = ANY($1)
        ORDER BY tm.title, t.name, t.id`,
      [teamIds] as SqlParam[],
      this.db,
    );
    return rows.map((row) => ({
      taskId: Number(row.task_id),
      taskName: row.task_name,
      teamId: Number(row.team_id),
      teamTitle: row.team_title,
    }));
  }

  /**
   * The assigned-count table cells (R12.3): for each (task type, assigned
   * member) the number of requests of that type assigned to that member,
   * REGARDLESS of status. Only cells with at least one request are returned;
   * the route zero-fills the full (row × column) grid so an absent cell reads as
   * 0. Requests with no assigned member contribute no cell. Keyed on the task
   * type across all versions (R16.4). The team set is bound as $1.
   */
  private async assignedCounts(teamIds: number[]): Promise<AssignedCountCell[]> {
    const rows = await many<AssignedCountDbRow>(
      `SELECT t.id                 AS task_id,
              r.assigned_member_id AS member_id,
              COUNT(*)             AS count
         FROM request r
         JOIN task_version tv ON tv.id = r.task_version_id
         JOIN task t          ON t.id = tv.task_id
        WHERE r.team_id = ANY($1)
          AND r.assigned_member_id IS NOT NULL
        GROUP BY t.id, r.assigned_member_id`,
      [teamIds] as SqlParam[],
      this.db,
    );
    return rows.map((row) => ({
      taskId: Number(row.task_id),
      memberId: Number(row.member_id),
      count: Number(row.count),
    }));
  }

  /**
   * The Accepted→Complete average-duration table cells (R12.4): for each (task
   * type, assigned member) the average duration in seconds from the ACCEPTED
   * moment to the COMPLETE moment, over that member's requests that reached BOTH
   * moments and whose CURRENT status is NOT Rejected/Cancelled.
   *
   * The transition moments come from `audit_entry` status changes:
   *   • `accepted_at` = MIN(changed_at) where new_value = ACCEPTED ($2);
   *   • `complete_at` = MIN(changed_at) where new_value = COMPLETE ($3).
   * The exclusion is applied by binding the two stop statuses as an array and
   * requiring `r.status <> ALL($4::text[])` (R12.4). Every status literal is
   * bound, never interpolated (R22.2). Durations use EXTRACT(EPOCH FROM …) →
   * seconds. Only (task, member) pairs with at least one qualifying request are
   * returned; the route zero-fills / null-fills the grid. The team set is $1.
   */
  private async avgAcceptedToComplete(
    teamIds: number[],
  ): Promise<AvgDurationCell[]> {
    const rows = await many<AvgDurationDbRow>(
      `WITH moments AS (
         SELECT r.id                  AS request_id,
                tv.task_id            AS task_id,
                r.assigned_member_id  AS member_id,
                r.status::text        AS status,
                (SELECT MIN(ae.changed_at)
                   FROM audit_entry ae
                  WHERE ae.entity_type = 'request'
                    AND ae.entity_id = r.id
                    AND ae.field_name = 'status'
                    AND ae.new_value = $2) AS accepted_at,
                (SELECT MIN(ae.changed_at)
                   FROM audit_entry ae
                  WHERE ae.entity_type = 'request'
                    AND ae.entity_id = r.id
                    AND ae.field_name = 'status'
                    AND ae.new_value = $3) AS complete_at
           FROM request r
           JOIN task_version tv ON tv.id = r.task_version_id
          WHERE r.team_id = ANY($1)
            AND r.assigned_member_id IS NOT NULL
       )
       SELECT m.task_id   AS task_id,
              m.member_id  AS member_id,
              AVG(EXTRACT(EPOCH FROM (m.complete_at - m.accepted_at)))
                FILTER (
                  WHERE m.complete_at IS NOT NULL
                    AND m.accepted_at IS NOT NULL
                    AND m.status <> ALL($4::text[])
                )        AS avg_accepted_to_complete_seconds
         FROM moments m
        GROUP BY m.task_id, m.member_id
       HAVING AVG(EXTRACT(EPOCH FROM (m.complete_at - m.accepted_at)))
                FILTER (
                  WHERE m.complete_at IS NOT NULL
                    AND m.accepted_at IS NOT NULL
                    AND m.status <> ALL($4::text[])
                ) IS NOT NULL`,
      [
        teamIds,
        ACCEPTED,
        COMPLETE,
        [...ACCEPTED_COMPLETE_EXCLUDED],
      ] as SqlParam[],
      this.db,
    );
    return rows.map((row) => ({
      taskId: Number(row.task_id),
      memberId: Number(row.member_id),
      avgAcceptedToCompleteSeconds:
        row.avg_accepted_to_complete_seconds == null
          ? null
          : Number(row.avg_accepted_to_complete_seconds),
    }));
  }
}
