import { Router, type RequestHandler } from 'express';
import { ApiError, errors } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/index.js';
import {
  DbSupportTeamMembersStore,
  type SupportTeamMember,
  type SupportTeamMembersStore,
} from './support-team-members.store.js';

/**
 * `GET /api/support/teams/:id/members` — the assignment drop-down source for
 * the Support detail view (design: "Support side"; R7.2).
 *
 *   GET /api/support/teams/:id/members  → { members: SupportTeamMemberJson[] }
 *
 * The Support detail screen lets a support member assign a request to any member
 * of the request's team (or unassign) — "any team member → any team member"
 * (R7.2). This read returns the candidate members so the drop-down can be built;
 * the actual assignment is applied (and re-validated) by the support-side PATCH.
 *
 * ── Authorisation (R7.2) ─────────────────────────────────────────────────────
 * Available to a SUPPORT MEMBER of the requested team. The global
 * {@link authenticate} middleware upstream guarantees `req.currentUser`; this
 * handler additionally membership-checks the `:id` against
 * `CurrentUser.teamsMemberOf` — a caller may only ever read their own teams'
 * membership, so a team they are not a member of is FORBIDDEN. This mirrors the
 * membership convention the Support queue and statistics reads use.
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 * The handler depends on the narrow {@link SupportTeamMembersStore} so it
 * unit-tests with an in-memory fake (no database). Production wiring uses
 * {@link DbSupportTeamMembersStore}.
 */

// ── Public JSON view ────────────────────────────────────────────────────────

export interface SupportTeamMemberJson {
  readonly userId: number;
  readonly username: string;
  readonly displayName: string;
}

export function serializeMember(member: SupportTeamMember): SupportTeamMemberJson {
  return {
    userId: member.userId,
    username: member.username,
    displayName: member.displayName,
  };
}

// ── Param parsing ─────────────────────────────────────────────────────────────

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

/** Read and validate the `:id` path param, or throw VALIDATION_FAILED. */
function teamIdParam(req: { params: Record<string, unknown> }): number {
  const id = toPositiveInt(req.params['id']);
  if (id === null) {
    throw errors.validationFailed('A valid team id is required.', { field: 'id' });
  }
  return id;
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

// ── Handler ─────────────────────────────────────────────────────────────────────

/** `GET /support/teams/:id/members` — list a team's members for assignment (R7.2). */
export function makeListTeamMembersHandler(
  store: SupportTeamMembersStore,
): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const teamId = teamIdParam(req as never);
      const user = currentUser(req);
      // A caller may only ever read their own teams' membership (R7.2).
      if (!user.teamsMemberOf.includes(teamId)) {
        throw errors.forbidden('You are not a member of the requested team.', {
          field: 'id',
        });
      }
      const members = await store.listMembers(teamId);
      res.status(200).json({ members: members.map(serializeMember) });
    })().catch(next);
  };
}

/**
 * Register the support team-members route on a router (mounted at
 * `/api/support`), so the full path is `GET /api/support/teams/:id/members`.
 * The store is injected for testability; production uses
 * {@link DbSupportTeamMembersStore}.
 */
export function registerSupportTeamMembersRoute(
  router: Router,
  store: SupportTeamMembersStore,
): Router {
  router.get('/teams/:id/members', makeListTeamMembersHandler(store));
  return router;
}

/** A standalone router (used by tests and for isolated wiring). */
export function createSupportTeamMembersRouter(
  store: SupportTeamMembersStore,
): Router {
  return registerSupportTeamMembersRoute(Router(), store);
}
