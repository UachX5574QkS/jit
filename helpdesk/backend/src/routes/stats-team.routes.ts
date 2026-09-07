import { Router, type RequestHandler } from 'express';
import { ApiError } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/index.js';
import type { Status } from '../status/index.js';
import { resolveTimezone } from './stats-user.routes.js';
import {
  DbTeamStatsStore,
  type StatusMonthBucket,
  type TypeCountSlice,
  type TypeSummaryRow,
  type TypeTimeSlice,
  type TeamStatsQuery,
  type TeamStatsStore,
  type TeamStatsView,
} from './stats-team.store.js';

/**
 * `GET /api/stats/team` — the Team Statistics dashboard (design: "Statistics" —
 * `GET /api/stats/team` — hierarchy-scoped; R11, R19).
 *
 * ── What it returns ──────────────────────────────────────────────────────────
 * The SAME four datasets as User Statistics (task 8.1), but scoped to the
 * requests raised by everyone in the current user's DOWNWARD management
 * hierarchy (R11.1, R19) rather than the caller's own requests:
 *   • `statusByMonth` — (month, status, count) buckets for the stacked bar,
 *     with the month computed in the viewer's timezone (R11.2 → R10.1, R18.3);
 *   • `typeCounts`    — (taskId, taskName, count) slices for the type pie (R10.2);
 *   • `timeByType`    — (taskId, taskName, totalMinutes) slices for the
 *     time-by-type pie (R10.3);
 *   • `summary`       — one row per task type with the request count, the count
 *     per status, and the average New→Triage and Triage→Complete durations in
 *     seconds; Triage→Complete excludes Rejected/Cancelled (R10.4, R10.5).
 *
 * ── Scope (R11.1, R19) ───────────────────────────────────────────────────────
 * The population is the current user's downward hierarchy — their direct
 * reports and, recursively, those reports' reports — resolved through the SAME
 * manager-hierarchy resolver (task 3.6, R19) that the "My Team" request list
 * uses, so the area-manager cutoff (R19.2) and cycle guard (R19.4) hold here
 * too. The scope derives entirely from `req.currentUser.id`; a caller can never
 * request another manager's team, and a leaf manager with no reports gets empty
 * datasets.
 *
 * ── Timezone (R11.2 → R10.1, R18.3) ──────────────────────────────────────────
 * Identical basis to User Statistics: an explicit valid `?tz=<IANA>` wins,
 * else `CurrentUser.timezone`, else `UTC`. The shared {@link resolveTimezone}
 * from the user-stats route enforces this and rejects an explicit invalid `?tz`
 * with VALIDATION_FAILED. The value is bound as a SQL parameter in the store,
 * never interpolated.
 *
 * ── Authorisation ────────────────────────────────────────────────────────────
 * Available to any authenticated user (R11 — a manager views their own team).
 * The global {@link authenticate} middleware mounted ahead of the stats router
 * rejects unauthenticated callers with 401, so `req.currentUser` is always
 * present.
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 * The handler depends on the narrow {@link TeamStatsStore} so it unit-tests with
 * an in-memory fake (no database). Production wiring uses {@link DbTeamStatsStore}.
 */

// ── Public JSON view (camelCase; seconds for durations) ────────────────────────

export interface StatusMonthBucketJson {
  readonly month: string;
  readonly status: Status;
  readonly count: number;
}

export interface TypeCountSliceJson {
  readonly taskId: number;
  readonly taskName: string;
  readonly count: number;
}

export interface TypeTimeSliceJson {
  readonly taskId: number;
  readonly taskName: string;
  readonly totalMinutes: number;
}

export interface TypeSummaryRowJson {
  readonly taskId: number;
  readonly taskName: string;
  readonly requestCount: number;
  readonly countByStatus: Readonly<Record<Status, number>>;
  readonly avgNewToTriageSeconds: number | null;
  readonly avgTriageToCompleteSeconds: number | null;
}

export interface TeamStatsJson {
  /** The IANA timezone the month buckets were computed in (echoed for clarity). */
  readonly timezone: string;
  readonly statusByMonth: StatusMonthBucketJson[];
  readonly typeCounts: TypeCountSliceJson[];
  readonly timeByType: TypeTimeSliceJson[];
  readonly summary: TypeSummaryRowJson[];
}

function serializeStatusMonth(b: StatusMonthBucket): StatusMonthBucketJson {
  return { month: b.month, status: b.status, count: b.count };
}

function serializeTypeCount(s: TypeCountSlice): TypeCountSliceJson {
  return { taskId: s.taskId, taskName: s.taskName, count: s.count };
}

function serializeTypeTime(s: TypeTimeSlice): TypeTimeSliceJson {
  return { taskId: s.taskId, taskName: s.taskName, totalMinutes: s.totalMinutes };
}

function serializeSummary(row: TypeSummaryRow): TypeSummaryRowJson {
  return {
    taskId: row.taskId,
    taskName: row.taskName,
    requestCount: row.requestCount,
    countByStatus: row.countByStatus,
    avgNewToTriageSeconds: row.avgNewToTriageSeconds,
    avgTriageToCompleteSeconds: row.avgTriageToCompleteSeconds,
  };
}

/** Serialise the store {@link TeamStatsView} into its public JSON view. */
export function serializeTeamStats(
  view: TeamStatsView,
  timezone: string,
): TeamStatsJson {
  return {
    timezone,
    statusByMonth: view.statusByMonth.map(serializeStatusMonth),
    typeCounts: view.typeCounts.map(serializeTypeCount),
    timeByType: view.timeByType.map(serializeTypeTime),
    summary: view.summary.map(serializeSummary),
  };
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
 * `GET /stats/team` — return the Team Statistics datasets for the current user's
 * downward hierarchy (R11, R19, R18.3). The store is injected for testability;
 * production uses {@link DbTeamStatsStore}.
 */
export function makeGetTeamStatsHandler(store: TeamStatsStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const user = currentUser(req);
      const timezone = resolveTimezone(
        (req.query as Record<string, unknown>)['tz'],
        user,
      );
      const query: TeamStatsQuery = { userId: user.id, timezone };
      const view = await store.getTeamStats(query);
      res.status(200).json(serializeTeamStats(view, timezone));
    })().catch(next);
  };
}

/**
 * Register the team-statistics route on a router (mounted at `/api/stats`). The
 * store is injected for testability; production uses {@link DbTeamStatsStore}.
 */
export function registerTeamStatsRoute(
  router: Router,
  store: TeamStatsStore,
): Router {
  router.get('/team', makeGetTeamStatsHandler(store));
  return router;
}

/** A standalone team-statistics router (used by tests and for isolated wiring). */
export function createTeamStatsRouter(store: TeamStatsStore): Router {
  return registerTeamStatsRoute(Router(), store);
}
