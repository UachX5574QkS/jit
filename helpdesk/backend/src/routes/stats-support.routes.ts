import { Router, type RequestHandler } from 'express';
import { ApiError, errors } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/index.js';
import type { Status } from '../status/index.js';
import { resolveTimezone } from './stats-user.routes.js';
import {
  DbSupportStatsStore,
  type AssignedCountCell,
  type AvgDurationCell,
  type MemberColumn,
  type StatusMonthBucket,
  type SupportStatsQuery,
  type SupportStatsStore,
  type SupportStatsView,
  type TaskRow,
} from './stats-support.store.js';

/**
 * `GET /api/stats/support` — the Support Statistics dashboard (design:
 * "Statistics" — `GET /api/stats/support?team=|all` — team-level tables +
 * chart; R12).
 *
 * ── What it returns ──────────────────────────────────────────────────────────
 * A SUPPORT-side view scoped to a support team (or every team the current user
 * is in). It aggregates the requests a team OWNS (`request.team_id`), not the
 * requests a person raised. It returns:
 *   • `team`           — the drop-down selection echoed back ("all" or a team id);
 *   • `timezone`       — the IANA timezone the month buckets were computed in;
 *   • `statusByMonth`  — (month, status, count) buckets for the stacked bar,
 *     bucketed in the viewer's timezone (R12.2 → R18.3);
 *   • `members`        — the shared COLUMNS of both tables (the team members in
 *     scope, R12.3/R12.4);
 *   • `rows`           — the shared ROWS of both tables (task types in scope);
 *     each carries the team + task so the frontend renders "Team - Task" when
 *     more than one team is in scope (R12.3);
 *   • `assignedCounts` — a DENSE (rows × members) grid: how many requests of
 *     each task type are assigned to each member, regardless of status (R12.3);
 *   • `avgAcceptedToComplete` — a DENSE grid of the average Accepted→Complete
 *     duration in seconds per (task type, member), excluding Rejected/Cancelled
 *     (R12.4); a cell with no qualifying request is `null`.
 *
 * ── Team selector + "All Teams" (R12.1) ──────────────────────────────────────
 * The `team` query param drives the drop-down (support-member convention shared
 * with the Support-queue list, task 7.1). It is membership-checked against
 * `CurrentUser.teamsMemberOf`:
 *   • "all" (default, or omitted) → EVERY team the user is in;
 *   • a specific team id → that ONE team, but only when the user is a member of
 *     it; otherwise FORBIDDEN (a caller can never scope to a team they are not
 *     in). Any other value is VALIDATION_FAILED.
 * A user in NO teams resolves to an empty scope and gets empty datasets (there
 * is no team to report on) — but an explicit `team` param is always
 * membership-checked, so a no-teams user asking for a specific team is FORBIDDEN.
 *
 * ── Timezone (R12.2 → R18.3) ─────────────────────────────────────────────────
 * Identical basis to User/Team Statistics: an explicit valid `?tz=<IANA>` wins,
 * else `CurrentUser.timezone`, else `UTC`. The shared {@link resolveTimezone}
 * enforces this and rejects an explicit invalid `?tz` with VALIDATION_FAILED.
 * The value is bound as a SQL parameter in the store, never interpolated.
 *
 * ── Authorisation (R12.1) ────────────────────────────────────────────────────
 * A support-side screen: available to SUPPORT MEMBERS (a user in at least one
 * team). The global {@link authenticate} middleware upstream guarantees
 * `req.currentUser`; the scope derives entirely from `CurrentUser.teamsMemberOf`
 * and the membership-checked `team` param, so a caller can never see another
 * team's statistics.
 *
 * ── Dense grid serialisation ─────────────────────────────────────────────────
 * The store returns only the (task, member) cells that have data. The route
 * ZERO-FILLS the assigned-count grid and NULL-FILLS the duration grid across the
 * full (rows × members) cross-product so the frontend can render a stable table
 * without probing for missing cells (R12.3/R12.4).
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 * The handler depends on the narrow {@link SupportStatsStore} so it unit-tests
 * with an in-memory fake (no database). Production wiring uses
 * {@link DbSupportStatsStore}.
 */

/** The team drop-down selection echoed back: "all" or a specific team id (R12.1). */
export type SupportStatsTeamSelection = 'all' | number;

// ── Public JSON view (camelCase; seconds for durations) ────────────────────────

export interface StatusMonthBucketJson {
  readonly month: string;
  readonly status: Status;
  readonly count: number;
}

export interface MemberColumnJson {
  readonly memberId: number;
  readonly memberName: string;
}

export interface TaskRowJson {
  readonly taskId: number;
  readonly taskName: string;
  readonly teamId: number;
  readonly teamTitle: string;
  /**
   * The label to render for the row: the task name for a single team, or
   * "Team - Task" when more than one team is in scope (R12.3).
   */
  readonly label: string;
}

export interface AssignedCountCellJson {
  readonly taskId: number;
  readonly memberId: number;
  readonly count: number;
}

export interface AvgDurationCellJson {
  readonly taskId: number;
  readonly memberId: number;
  readonly avgAcceptedToCompleteSeconds: number | null;
}

export interface SupportStatsJson {
  readonly team: SupportStatsTeamSelection;
  readonly timezone: string;
  readonly statusByMonth: StatusMonthBucketJson[];
  readonly members: MemberColumnJson[];
  readonly rows: TaskRowJson[];
  readonly assignedCounts: AssignedCountCellJson[];
  readonly avgAcceptedToComplete: AvgDurationCellJson[];
}

function serializeStatusMonth(b: StatusMonthBucket): StatusMonthBucketJson {
  return { month: b.month, status: b.status, count: b.count };
}

function serializeMember(m: MemberColumn): MemberColumnJson {
  return { memberId: m.memberId, memberName: m.memberName };
}

/**
 * Build the row label: just the task name when a single team is in scope, or
 * "Team - Task" when more than one team is being shown so tasks from different
 * teams are distinguishable (R12.3).
 */
function rowLabel(row: TaskRow, multiTeam: boolean): string {
  return multiTeam ? `${row.teamTitle} - ${row.taskName}` : row.taskName;
}

function serializeRow(row: TaskRow, multiTeam: boolean): TaskRowJson {
  return {
    taskId: row.taskId,
    taskName: row.taskName,
    teamId: row.teamId,
    teamTitle: row.teamTitle,
    label: rowLabel(row, multiTeam),
  };
}

/**
 * Zero-fill the assigned-count grid across the full (rows × members)
 * cross-product (R12.3). The store returns only non-zero cells; an absent
 * (task, member) pair reads as 0.
 */
export function densifyAssignedCounts(
  rows: ReadonlyArray<TaskRow>,
  members: ReadonlyArray<MemberColumn>,
  cells: ReadonlyArray<AssignedCountCell>,
): AssignedCountCellJson[] {
  const byKey = new Map<string, number>();
  for (const c of cells) {
    byKey.set(`${c.taskId}:${c.memberId}`, c.count);
  }
  const out: AssignedCountCellJson[] = [];
  for (const row of rows) {
    for (const member of members) {
      out.push({
        taskId: row.taskId,
        memberId: member.memberId,
        count: byKey.get(`${row.taskId}:${member.memberId}`) ?? 0,
      });
    }
  }
  return out;
}

/**
 * Null-fill the Accepted→Complete duration grid across the full (rows ×
 * members) cross-product (R12.4). The store returns only cells with a computed
 * average; an absent (task, member) pair reads as `null` (no qualifying
 * request).
 */
export function densifyAvgDurations(
  rows: ReadonlyArray<TaskRow>,
  members: ReadonlyArray<MemberColumn>,
  cells: ReadonlyArray<AvgDurationCell>,
): AvgDurationCellJson[] {
  const byKey = new Map<string, number | null>();
  for (const c of cells) {
    byKey.set(`${c.taskId}:${c.memberId}`, c.avgAcceptedToCompleteSeconds);
  }
  const out: AvgDurationCellJson[] = [];
  for (const row of rows) {
    for (const member of members) {
      out.push({
        taskId: row.taskId,
        memberId: member.memberId,
        avgAcceptedToCompleteSeconds:
          byKey.get(`${row.taskId}:${member.memberId}`) ?? null,
      });
    }
  }
  return out;
}

/** Serialise the store {@link SupportStatsView} into its public JSON view. */
export function serializeSupportStats(
  view: SupportStatsView,
  team: SupportStatsTeamSelection,
  timezone: string,
): SupportStatsJson {
  // "All Teams" is a multi-team view when the resolved scope actually spans more
  // than one team; a single-team scope (even under "all") uses the bare task
  // name so the label matches what the user sees.
  const teamIds = new Set(view.rows.map((r) => r.teamId));
  const multiTeam = teamIds.size > 1;
  return {
    team,
    timezone,
    statusByMonth: view.statusByMonth.map(serializeStatusMonth),
    members: view.members.map(serializeMember),
    rows: view.rows.map((r) => serializeRow(r, multiTeam)),
    assignedCounts: densifyAssignedCounts(view.rows, view.members, view.assignedCounts),
    avgAcceptedToComplete: densifyAvgDurations(
      view.rows,
      view.members,
      view.avgAcceptedToComplete,
    ),
  };
}

// ── Query parsing (R12.1) ──────────────────────────────────────────────────────

/**
 * Parse the `team` drop-down param (R12.1). Defaults to "all" when absent/blank.
 * "all" (case-insensitive) means every team the user is in; a positive integer
 * string means that specific team id. Anything else is VALIDATION_FAILED so a
 * typo never silently changes the scope. Membership is enforced separately in
 * {@link resolveTeamScope} once the current user is known.
 */
export function parseTeam(raw: unknown): SupportStatsTeamSelection {
  if (raw === undefined || raw === null || raw === '') {
    return 'all';
  }
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v === 'all') {
      return 'all';
    }
    if (/^\d+$/.test(v)) {
      const id = Number(v);
      if (Number.isSafeInteger(id) && id > 0) {
        return id;
      }
    }
  }
  throw errors.validationFailed('team must be "all" or a team id.', { field: 'team' });
}

/**
 * Resolve the membership-checked team scope (R12.1). The authoritative set is
 * `CurrentUser.teamsMemberOf`:
 *   • team = "all" → every team the user is in (may be empty for a no-teams
 *     user, in which case the store returns empty datasets).
 *   • a specific team id → that team, but ONLY when the user is a member of it;
 *     otherwise FORBIDDEN (a caller may only ever see their own teams' stats).
 */
export function resolveTeamScope(
  team: SupportStatsTeamSelection,
  user: CurrentUser,
): number[] {
  const memberOf = user.teamsMemberOf;
  if (team === 'all') {
    return [...memberOf];
  }
  if (!memberOf.includes(team)) {
    throw errors.forbidden('You are not a member of the requested team.', {
      field: 'team',
    });
  }
  return [team];
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

/**
 * `GET /stats/support` — return the Support Statistics datasets for the selected
 * team (or all the user's teams), with month buckets in the viewer's timezone
 * (R12, R18.3). The store is injected for testability; production uses
 * {@link DbSupportStatsStore}.
 */
export function makeGetSupportStatsHandler(store: SupportStatsStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const user = currentUser(req);
      const query = req.query as Record<string, unknown>;
      const team = parseTeam(query['team']);
      const teamIds = resolveTeamScope(team, user);
      const timezone = resolveTimezone(query['tz'], user);

      const statsQuery: SupportStatsQuery = { teamIds, timezone };
      const view = await store.getSupportStats(statsQuery);
      res.status(200).json(serializeSupportStats(view, team, timezone));
    })().catch(next);
  };
}

/**
 * Register the support-statistics route on a router (mounted at `/api/stats`).
 * The store is injected for testability; production uses {@link DbSupportStatsStore}.
 */
export function registerSupportStatsRoute(
  router: Router,
  store: SupportStatsStore,
): Router {
  router.get('/support', makeGetSupportStatsHandler(store));
  return router;
}

/** A standalone support-statistics router (used by tests and for isolated wiring). */
export function createSupportStatsRouter(store: SupportStatsStore): Router {
  return registerSupportStatsRoute(Router(), store);
}
