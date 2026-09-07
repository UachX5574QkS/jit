import { Router, type RequestHandler } from 'express';
import { ApiError, errors } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/index.js';
import type { Status } from '../status/index.js';
import {
  DbUserStatsStore,
  type StatusMonthBucket,
  type TypeCountSlice,
  type TypeSummaryRow,
  type TypeTimeSlice,
  type UserStatsQuery,
  type UserStatsStore,
  type UserStatsView,
} from './stats-user.store.js';

/**
 * `GET /api/stats/user` — the User Statistics dashboard (design: "Statistics" —
 * `GET /api/stats/user` — charts + summary table for the current user; R10,
 * R18.3).
 *
 * ── What it returns ──────────────────────────────────────────────────────────
 * Four datasets, all scoped to the requests the CURRENT USER raised:
 *   • `statusByMonth` — (month, status, count) buckets for the stacked bar,
 *     with the month computed in the viewer's timezone (R10.1, R18.3);
 *   • `typeCounts`    — (taskId, taskName, count) slices for the type pie (R10.2);
 *   • `timeByType`    — (taskId, taskName, totalMinutes) slices for the
 *     time-by-type pie (R10.3);
 *   • `summary`       — one row per task type with the request count, the count
 *     per status, and the average New→Triage and Triage→Complete durations in
 *     seconds; Triage→Complete excludes Rejected/Cancelled (R10.4, R10.5).
 *
 * ── Timezone (R10.1, R18.3) ──────────────────────────────────────────────────
 * The "by month" buckets are computed in the viewer's timezone. The client may
 * pass its browser timezone as `?tz=<IANA>` (e.g. `Europe/London`); when
 * absent, the handler falls back to `CurrentUser.timezone`, then to `UTC`. The
 * value is validated as a plausible IANA name before it reaches the store (and
 * is bound as a SQL parameter there, never interpolated).
 *
 * ── Authorisation ────────────────────────────────────────────────────────────
 * Available to any authenticated user (R10). The global {@link authenticate}
 * middleware mounted ahead of the stats router rejects unauthenticated callers
 * with 401, so `req.currentUser` is always present. Every dataset aggregates
 * only the caller's own requests, so nothing outside their scope is exposed.
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 * The handler depends on the narrow {@link UserStatsStore} so it unit-tests with
 * an in-memory fake (no database). Production wiring uses {@link DbUserStatsStore}.
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

export interface UserStatsJson {
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

/** Serialise the store {@link UserStatsView} into its public JSON view. */
export function serializeUserStats(
  view: UserStatsView,
  timezone: string,
): UserStatsJson {
  return {
    timezone,
    statusByMonth: view.statusByMonth.map(serializeStatusMonth),
    typeCounts: view.typeCounts.map(serializeTypeCount),
    timeByType: view.timeByType.map(serializeTypeTime),
    summary: view.summary.map(serializeSummary),
  };
}

// ── Timezone parsing (R10.1, R18.3) ────────────────────────────────────────────

/**
 * Validate a candidate IANA timezone. Uses the platform's own timezone database
 * via `Intl.DateTimeFormat` so only names Postgres/`AT TIME ZONE` will also
 * accept are allowed; an invalid name throws, which we translate to
 * VALIDATION_FAILED. This keeps an untrusted string from ever reaching SQL as
 * anything other than a validated, bound parameter.
 */
export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.trim() === '') {
    return false;
  }
  try {
    // Throws RangeError for an unknown/malformed timezone.
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the timezone the month buckets are computed in: an explicit, valid
 * `?tz=` wins; otherwise the current user's stored timezone if valid; otherwise
 * `UTC`. An explicit but invalid `?tz=` is a VALIDATION_FAILED rather than a
 * silent fallback, so a typo never quietly changes the buckets.
 */
export function resolveTimezone(rawTz: unknown, user: CurrentUser): string {
  if (typeof rawTz === 'string' && rawTz.trim() !== '') {
    const tz = rawTz.trim();
    if (!isValidTimezone(tz)) {
      throw errors.validationFailed('tz must be a valid IANA timezone.', {
        field: 'tz',
      });
    }
    return tz;
  }
  if (user.timezone && isValidTimezone(user.timezone)) {
    return user.timezone;
  }
  return 'UTC';
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
 * `GET /stats/user` — return the User Statistics datasets for the current user
 * (R10, R18.3). The store is injected for testability; production uses
 * {@link DbUserStatsStore}.
 */
export function makeGetUserStatsHandler(store: UserStatsStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const user = currentUser(req);
      const timezone = resolveTimezone(
        (req.query as Record<string, unknown>)['tz'],
        user,
      );
      const query: UserStatsQuery = { userId: user.id, timezone };
      const view = await store.getUserStats(query);
      res.status(200).json(serializeUserStats(view, timezone));
    })().catch(next);
  };
}

/**
 * Register the user-statistics route on a router (mounted at `/api/stats`). The
 * store is injected for testability; production uses {@link DbUserStatsStore}.
 */
export function registerUserStatsRoute(
  router: Router,
  store: UserStatsStore,
): Router {
  router.get('/user', makeGetUserStatsHandler(store));
  return router;
}

/** A standalone user-statistics router (used by tests and for isolated wiring). */
export function createUserStatsRouter(store: UserStatsStore): Router {
  return registerUserStatsRoute(Router(), store);
}
