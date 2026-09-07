import { Router, type RequestHandler } from 'express';
import { ApiError, errors } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/index.js';
import {
  DbRequestListStore,
  type ListViewer,
  type RequestListQuery,
  type RequestListRow,
  type RequestListScope,
  type RequestListStore,
} from './requests-list.store.js';

/**
 * `GET /api/requests` — the user-side Requests list (design: "Requests (user
 * side)" — `GET /api/requests?scope=mine|team&hideComplete=&q=` — list for
 * Requests screen, hierarchy-scoped; R4.1–4.4, R4.9, R19).
 *
 * ── Query parameters ─────────────────────────────────────────────────────────
 *   scope         "mine" (default) shows requests the caller raised; "team"
 *                 ("My Team") shows requests raised by anyone in the caller's
 *                 downward management hierarchy (R4.3, R19). Any other value is
 *                 VALIDATION_FAILED.
 *   hideComplete  defaults to TRUE. When true, COMPLETE/REJECTED/CANCELLED
 *                 requests are excluded (R4.4). Accepts the usual truthy/falsy
 *                 spellings ("true"/"false"/"1"/"0"); absent means the default.
 *   q             optional free-text search; filters on any field in scope
 *                 (R4.2). Trimmed; blank is treated as "no search".
 *
 * ── Authorisation ────────────────────────────────────────────────────────────
 * Available to any authenticated user (R4.1). The global {@link authenticate}
 * middleware mounted ahead of the requests router rejects unauthenticated
 * callers with 401, so `req.currentUser` is always present. Scope is derived
 * entirely from the current user's id / hierarchy, so a caller can only ever see
 * their own requests or those under their management chain — the list never
 * leaks a request outside the caller's scope.
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 * The handler depends on the narrow {@link RequestListStore} so it unit-tests
 * with an in-memory fake (no database). Production wiring uses
 * {@link DbRequestListStore}.
 */

// ── Public JSON view (camelCase, ISO dates) ────────────────────────────────────

export interface RequestListRowJson {
  readonly id: number;
  readonly taskReference: string;
  readonly jiraNumber: string | null;
  readonly title: string;
  readonly dateRaised: string;
  readonly status: string;
  readonly teamId: number;
  readonly teamTitle: string;
  readonly assignedMemberId: number | null;
  readonly assignedMemberName: string | null;
  readonly lastUpdated: string;
  readonly estimatedStartDate: string | null;
  readonly actualStartDate: string | null;
  readonly hasOpenTimer: boolean;
  readonly estimatedEffortMinutes: number | null;
  /** The viewer's "Updated" indicator (R4.8, R7.5, R7.6) — always a boolean. */
  readonly updatedSinceLastSeen: boolean;
}

export interface RequestListJson {
  readonly scope: RequestListScope;
  readonly hideComplete: boolean;
  readonly search: string | null;
  readonly requests: RequestListRowJson[];
}

function serializeRow(row: RequestListRow): RequestListRowJson {
  return {
    id: row.id,
    taskReference: row.taskReference,
    jiraNumber: row.jiraNumber,
    title: row.title,
    dateRaised: row.dateRaised,
    status: row.status,
    teamId: row.teamId,
    teamTitle: row.teamTitle,
    assignedMemberId: row.assignedMemberId,
    assignedMemberName: row.assignedMemberName,
    lastUpdated: row.lastUpdated,
    estimatedStartDate: row.estimatedStartDate,
    actualStartDate: row.actualStartDate,
    hasOpenTimer: row.hasOpenTimer,
    estimatedEffortMinutes: row.estimatedEffortMinutes,
    updatedSinceLastSeen: row.updatedSinceLastSeen,
  };
}

// ── Query parsing ──────────────────────────────────────────────────────────────

/** Parse the `scope` query param, defaulting to "mine"; throws on an unknown value. */
export function parseScope(raw: unknown): RequestListScope {
  if (raw === undefined || raw === null || raw === '') {
    return 'mine';
  }
  if (raw === 'mine' || raw === 'team') {
    return raw;
  }
  throw errors.validationFailed('scope must be "mine" or "team".', { field: 'scope' });
}

/**
 * Parse the `hideComplete` query param (R4.4). Defaults to TRUE when absent.
 * Accepts "true"/"false"/"1"/"0" (case-insensitive); anything else is
 * VALIDATION_FAILED so a typo never silently changes the filter.
 */
export function parseHideComplete(raw: unknown): boolean {
  if (raw === undefined || raw === null || raw === '') {
    return true;
  }
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase();
    if (v === 'true' || v === '1') {
      return true;
    }
    if (v === 'false' || v === '0') {
      return false;
    }
  }
  throw errors.validationFailed('hideComplete must be true or false.', {
    field: 'hideComplete',
  });
}

/** Parse the optional `q` search param; trimmed, blank → null (R4.2). */
export function parseSearch(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/** Build the normalised {@link RequestListQuery} from the raw query string. */
export function parseListQuery(query: Record<string, unknown>): RequestListQuery {
  return {
    scope: parseScope(query['scope']),
    hideComplete: parseHideComplete(query['hideComplete']),
    search: parseSearch(query['q']),
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

/** Build the {@link ListViewer} the store consumes from the current user. */
function toViewer(user: CurrentUser): ListViewer {
  return { userId: user.id };
}

/**
 * `GET /requests` — return the Requests list for the active scope (R4.1–4.4,
 * R4.9, R19). The store is injected for testability; production uses
 * {@link DbRequestListStore}.
 */
export function makeListRequestsHandler(store: RequestListStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const listQuery = parseListQuery(req.query as Record<string, unknown>);
      const viewer = toViewer(currentUser(req));
      const rows = await store.list(listQuery, viewer);
      const body: RequestListJson = {
        scope: listQuery.scope,
        hideComplete: listQuery.hideComplete,
        search: listQuery.search,
        requests: rows.map(serializeRow),
      };
      res.status(200).json(body);
    })().catch(next);
  };
}

/**
 * Register the requests-list route on a router (mounted at `/api`). Attached to
 * the passed-in router so it shares the requests router's `/requests` prefix.
 * The store is injected for testability; production uses
 * {@link DbRequestListStore}.
 */
export function registerRequestListRoute(
  router: Router,
  store: RequestListStore,
): Router {
  router.get('/requests', makeListRequestsHandler(store));
  return router;
}

/** A standalone requests-list router (used by tests and for isolated wiring). */
export function createRequestListRouter(store: RequestListStore): Router {
  return registerRequestListRoute(Router(), store);
}
