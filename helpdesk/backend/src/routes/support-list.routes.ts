import { Router, type RequestHandler } from 'express';
import { ApiError, errors } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/index.js';
import {
  DbSupportListStore,
  type SupportListQuery,
  type SupportListRow,
  type SupportListScope,
  type SupportListStore,
  type SupportListViewer,
} from './support-list.store.js';

/**
 * `GET /api/support/requests` — the Support-queue list (design: "Support side"
 * — `GET /api/support/requests?team=&scope=mine|team&hideComplete=&
 * showUnassigned=&q=`; R6).
 *
 * ── Query parameters ─────────────────────────────────────────────────────────
 *   team           the "Team" drop-down (R6.3). "all" (default, or omitted)
 *                  means ALL the teams the user is in; a specific numeric team
 *                  id means that ONE team — but only when the user is a member
 *                  of it (else FORBIDDEN). Any other value is VALIDATION_FAILED.
 *   scope          "mine" (default) → "My Queue": requests assigned to the
 *                  caller; "team" → "Team Queue": requests for the selected
 *                  team(s) (R6.4). Any other value is VALIDATION_FAILED.
 *   hideComplete   defaults to TRUE. When true, COMPLETE/CANCELLED/REJECTED
 *                  requests are excluded (R6.5). Accepts "true"/"false"/"1"/"0";
 *                  absent means the default.
 *   showUnassigned defaults to TRUE. When true, requests with no assigned member
 *                  are included; when false they are excluded (R6.6). Same
 *                  truthy/falsy spellings; absent means the default.
 *   q              optional free-text search; filters on any field within the
 *                  active toggle + team drop-down scope (R6.2). Trimmed; blank
 *                  is treated as "no search".
 *
 * ── Authorisation (R6.1) ─────────────────────────────────────────────────────
 * Available to SUPPORT MEMBERS — a support member is a user who is a member of
 * at least one team (`CurrentUser.teamsMemberOf` non-empty). The global
 * {@link authenticate} middleware upstream guarantees `req.currentUser`; this
 * handler additionally derives the team scope from `CurrentUser.teamsMemberOf`
 * (the authoritative set, R6.3):
 *   • A user in NO teams has an empty scope. Per the design we return an empty
 *     list (there is no team queue to show) rather than erroring — the Support
 *     screen simply has nothing in it. An explicit `team` param, however, is
 *     always membership-checked, so a no-teams user asking for a specific team
 *     is FORBIDDEN.
 *   • A specific `team` the user is NOT a member of is FORBIDDEN (a caller may
 *     only ever see their own teams' queues, never another team's).
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 * The handler depends on the narrow {@link SupportListStore} so it unit-tests
 * with an in-memory fake (no database). Production wiring uses
 * {@link DbSupportListStore}.
 */

// ── Public JSON view (camelCase, ISO dates) — same columns as the Requests screen (R6.7) ──

export interface SupportListRowJson {
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

/**
 * The team drop-down selection echoed back: "all" or the specific team id the
 * caller asked for, so the frontend can keep the drop-down in sync (R6.3).
 */
export type SupportTeamSelection = 'all' | number;

export interface SupportListJson {
  readonly team: SupportTeamSelection;
  readonly scope: SupportListScope;
  readonly hideComplete: boolean;
  readonly showUnassigned: boolean;
  readonly search: string | null;
  readonly requests: SupportListRowJson[];
}

function serializeRow(row: SupportListRow): SupportListRowJson {
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

/**
 * Parse the `team` drop-down param (R6.3). Defaults to "all" when absent/blank.
 * "all" (case-insensitive) means every team the user is in; a positive integer
 * string means that specific team id. Anything else is VALIDATION_FAILED so a
 * typo never silently changes the scope. Membership is enforced separately in
 * {@link resolveTeamScope} once the current user is known.
 */
export function parseTeam(raw: unknown): SupportTeamSelection {
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

/** Parse the `scope` query param, defaulting to "mine"; throws on an unknown value. */
export function parseScope(raw: unknown): SupportListScope {
  if (raw === undefined || raw === null || raw === '') {
    return 'mine';
  }
  if (raw === 'mine' || raw === 'team') {
    return raw;
  }
  throw errors.validationFailed('scope must be "mine" or "team".', { field: 'scope' });
}

/**
 * Parse a boolean-ish flag param defaulting to TRUE when absent. Accepts
 * "true"/"false"/"1"/"0" (case-insensitive); anything else is VALIDATION_FAILED
 * so a typo never silently changes the filter. Used by both `hideComplete`
 * (R6.5) and `showUnassigned` (R6.6).
 */
function parseBooleanFlag(raw: unknown, field: string): boolean {
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
  throw errors.validationFailed(`${field} must be true or false.`, { field });
}

/** Parse the `hideComplete` query param (R6.5). Defaults to TRUE when absent. */
export function parseHideComplete(raw: unknown): boolean {
  return parseBooleanFlag(raw, 'hideComplete');
}

/** Parse the `showUnassigned` query param (R6.6). Defaults to TRUE when absent. */
export function parseShowUnassigned(raw: unknown): boolean {
  return parseBooleanFlag(raw, 'showUnassigned');
}

/** Parse the optional `q` search param; trimmed, blank → null (R6.2). */
export function parseSearch(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/** The parsed-but-not-yet-team-resolved query (team selection kept separate). */
interface ParsedSupportQuery {
  readonly team: SupportTeamSelection;
  readonly query: SupportListQuery;
}

/** Build the normalised query from the raw query string. */
export function parseSupportListQuery(query: Record<string, unknown>): ParsedSupportQuery {
  return {
    team: parseTeam(query['team']),
    query: {
      scope: parseScope(query['scope']),
      hideComplete: parseHideComplete(query['hideComplete']),
      showUnassigned: parseShowUnassigned(query['showUnassigned']),
      search: parseSearch(query['q']),
    },
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
 * Resolve the membership-checked team scope for the request (R6.3). The
 * authoritative set is `CurrentUser.teamsMemberOf`:
 *   • team = "all" → every team the user is in (may be empty for a no-teams
 *     user, in which case the caller returns an empty list).
 *   • a specific team id → that team, but ONLY when the user is a member of it;
 *     otherwise FORBIDDEN (a caller may only ever see their own teams' queues).
 */
export function resolveTeamScope(
  team: SupportTeamSelection,
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

/**
 * `GET /support/requests` — return the Support queue for the active team
 * drop-down + toggle (R6). The store is injected for testability; production
 * uses {@link DbSupportListStore}.
 */
export function makeListSupportRequestsHandler(store: SupportListStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const parsed = parseSupportListQuery(req.query as Record<string, unknown>);
      const user = currentUser(req);
      const teamIds = resolveTeamScope(parsed.team, user);

      // No teams in scope → nothing to query (the design prefers an empty list
      // for team scope over an error when the user is in no teams, R6.3).
      const rows =
        teamIds.length === 0
          ? []
          : await store.list(parsed.query, {
              userId: user.id,
              teamIds,
            } satisfies SupportListViewer);

      const body: SupportListJson = {
        team: parsed.team,
        scope: parsed.query.scope,
        hideComplete: parsed.query.hideComplete,
        showUnassigned: parsed.query.showUnassigned,
        search: parsed.query.search,
        requests: rows.map(serializeRow),
      };
      res.status(200).json(body);
    })().catch(next);
  };
}

/**
 * Register the support-list route on a router (mounted at `/api/support`), so
 * the full path is `GET /api/support/requests`. The store is injected for
 * testability; production uses {@link DbSupportListStore}.
 */
export function registerSupportListRoute(
  router: Router,
  store: SupportListStore,
): Router {
  router.get('/requests', makeListSupportRequestsHandler(store));
  return router;
}

/** A standalone support-list router (used by tests and for isolated wiring). */
export function createSupportListRouter(store: SupportListStore): Router {
  return registerSupportListRoute(Router(), store);
}
