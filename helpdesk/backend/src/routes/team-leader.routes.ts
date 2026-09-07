import { Router, type RequestHandler } from 'express';
import { ApiError, errors } from '../middleware/errors.js';
import { requireTeamLeadership } from '../middleware/authorize.js';
import {
  DbTeamLeaderStore,
  MemberRemovalConflictError,
  TeamNotFoundError,
  type TeamDetails,
  type TeamLeaderStore,
  type TeamMember,
  type TeamWithMembers,
  type UpdateTeamLeaderInput,
} from './team-leader.store.js';

/**
 * Team-Leader team-management endpoints (design: "Administration" —
 * `GET/PATCH /api/team-leader/teams/{id}` — membership + details, leader-only;
 * member-removal guarded, R15, R20.3).
 *
 *   GET   /api/team-leader/teams/:id   details + membership          (R15.2, R15.3)
 *   PATCH /api/team-leader/teams/:id   update details / change membership (R15.2–15.4)
 *
 * ── Authorisation: leader-of-THIS-team ───────────────────────────────────────
 * Both routes are guarded by {@link requireTeamLeadership} keyed on the `:id`
 * route parameter. This is DISTINCT from the admin-only team routes (task 5.1):
 * an administrator is NOT implicitly allowed here — only the recorded leader of
 * the specific team may reach these handlers, and everyone else (including a
 * leader of a DIFFERENT team) is rejected with the uniform `FORBIDDEN` (403)
 * envelope BEFORE any work happens (R15). This is the server-side enforcement
 * point; the frontend hiding the Team-Leader tiles is UX only.
 *
 * ── The member-removal guard (R15.4 / R20.3) ─────────────────────────────────
 * Removing a support member is refused while they still have any non-closed
 * request associated with them (assigned to them) under the team. The store
 * performs that check inside the mutation's transaction and raises {@link
 * MemberRemovalConflictError}; this layer maps it to the uniform
 * `CONFLICT_OPEN_REQUESTS` error (409). All existing requests are retained.
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 * Handlers depend on the narrow {@link TeamLeaderStore} so they unit-test with
 * an in-memory fake (no database), matching the team-admin/data-point style.
 * Production wiring uses {@link DbTeamLeaderStore}.
 */

/** The public JSON view of a team's details (camelCase, ISO dates). */
export interface TeamDetailsView {
  readonly id: number;
  readonly title: string;
  readonly description: string | null;
  readonly teamLeaderId: number;
  readonly isClosed: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The public JSON view of a team member. */
export interface TeamMemberView {
  readonly userId: number;
  readonly username: string;
  readonly displayName: string;
}

/** The public JSON view of a team with its membership (GET/PATCH response). */
export interface TeamWithMembersView {
  readonly team: TeamDetailsView;
  readonly members: TeamMemberView[];
}

/** Serialise a store {@link TeamWithMembers} into its public view. */
export function serializeTeamWithMembers(
  data: TeamWithMembers,
): TeamWithMembersView {
  return {
    team: serializeTeamDetails(data.team),
    members: data.members.map(serializeMember),
  };
}

function serializeTeamDetails(team: TeamDetails): TeamDetailsView {
  return {
    id: team.id,
    title: team.title,
    description: team.description,
    teamLeaderId: team.teamLeaderId,
    isClosed: team.isClosed,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
  };
}

function serializeMember(member: TeamMember): TeamMemberView {
  return {
    userId: member.userId,
    username: member.username,
    displayName: member.displayName,
  };
}

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

/**
 * Validate a list of member ids for add/remove (R15.3). Absent → empty list.
 * Each entry must be a positive integer; otherwise `VALIDATION_FAILED`.
 */
function readMemberIds(raw: unknown, field: string): number[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw errors.validationFailed(`${field} must be an array of user ids.`, {
      field,
    });
  }
  const ids: number[] = [];
  for (const entry of raw) {
    const id = toPositiveInt(entry);
    if (id === null) {
      throw errors.validationFailed(
        `${field} must contain only positive integer user ids.`,
        { field },
      );
    }
    ids.push(id);
  }
  return ids;
}

/**
 * Validate and normalise the update body (R15.2, R15.3). At least one of
 * `title`, `description`, `addMemberIds`, or `removeMemberIds` must be present
 * and meaningful; an empty patch is rejected with `VALIDATION_FAILED`.
 *
 *   - `title` (when present) must be a non-blank string; it is trimmed.
 *   - `description` (when present) may be a string (trimmed; empty → null) or
 *     `null` to clear it.
 *   - `addMemberIds` / `removeMemberIds` are positive-integer arrays.
 *
 * A user id appearing in BOTH add and remove is contradictory and rejected.
 */
export function readUpdateTeamLeaderBody(body: unknown): UpdateTeamLeaderInput {
  const record = (body ?? {}) as Record<string, unknown>;
  const input: {
    title?: string;
    description?: string | null;
    addMemberIds?: number[];
    removeMemberIds?: number[];
  } = {};

  if (record['title'] !== undefined) {
    const rawTitle = record['title'];
    if (typeof rawTitle !== 'string' || rawTitle.trim() === '') {
      throw errors.validationFailed('title must be a non-empty string.', {
        field: 'title',
      });
    }
    input.title = rawTitle.trim();
  }

  if (record['description'] !== undefined) {
    const rawDescription = record['description'];
    if (rawDescription === null) {
      input.description = null;
    } else if (typeof rawDescription === 'string') {
      const trimmed = rawDescription.trim();
      input.description = trimmed === '' ? null : trimmed;
    } else {
      throw errors.validationFailed('description must be a string or null.', {
        field: 'description',
      });
    }
  }

  const addMemberIds = readMemberIds(record['addMemberIds'], 'addMemberIds');
  const removeMemberIds = readMemberIds(
    record['removeMemberIds'],
    'removeMemberIds',
  );

  // A user id cannot be both added and removed in one request.
  const overlap = addMemberIds.filter((id) => removeMemberIds.includes(id));
  if (overlap.length > 0) {
    throw errors.validationFailed(
      'A user cannot be both added and removed in the same request.',
      { field: 'members', userIds: [...new Set(overlap)] },
    );
  }

  if (addMemberIds.length > 0) {
    input.addMemberIds = addMemberIds;
  }
  if (removeMemberIds.length > 0) {
    input.removeMemberIds = removeMemberIds;
  }

  if (
    input.title === undefined &&
    input.description === undefined &&
    input.addMemberIds === undefined &&
    input.removeMemberIds === undefined
  ) {
    throw errors.validationFailed(
      'Provide at least one of title, description, addMemberIds, or removeMemberIds.',
    );
  }

  return input;
}

/** Read the authenticated leader's id (authenticate guarantees `currentUser`). */
function actingUserId(req: { currentUser?: { id: number } }): number {
  const user = req.currentUser;
  if (!user) {
    // Defensive: requireTeamLeadership runs after authenticate, so unreachable.
    throw ApiError.of('FORBIDDEN', 'Authentication required', undefined, 401);
  }
  return user.id;
}

/** Parse `:id` from the route, throwing `VALIDATION_FAILED` when malformed. */
function readTeamId(req: { params: unknown }): number {
  const teamId = toPositiveInt((req.params as Record<string, unknown>)['id']);
  if (teamId === null) {
    throw errors.validationFailed('A valid team id is required.', {
      field: 'id',
    });
  }
  return teamId;
}

/** `GET /team-leader/teams/:id` — details + membership (R15.2, R15.3). */
export function createGetTeamHandler(store: TeamLeaderStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const teamId = readTeamId(req);
      try {
        const data = await store.getWithMembers(teamId);
        res.status(200).json(serializeTeamWithMembers(data));
      } catch (err) {
        throw mapStoreError(err);
      }
    })().catch(next);
  };
}

/**
 * `PATCH /team-leader/teams/:id` — update details and/or change membership
 * (R15.2, R15.3). Member removal is guarded by non-closed requests (R15.4 /
 * R20.3): a conflict is surfaced as `CONFLICT_OPEN_REQUESTS` (409); an unknown
 * id is a 404.
 */
export function createUpdateTeamHandler(store: TeamLeaderStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const teamId = readTeamId(req);
      const input = readUpdateTeamLeaderBody(req.body);
      try {
        const data = await store.update(teamId, input, actingUserId(req));
        res.status(200).json(serializeTeamWithMembers(data));
      } catch (err) {
        throw mapStoreError(err);
      }
    })().catch(next);
  };
}

/** Map store domain errors to the uniform error envelope. */
function mapStoreError(err: unknown): unknown {
  if (err instanceof MemberRemovalConflictError) {
    return errors.conflictOpenRequests(
      'Cannot remove a member with non-closed requests under this team.',
      {
        teamId: err.teamId,
        userId: err.userId,
        openRequestCount: err.openRequestCount,
      },
    );
  }
  if (err instanceof TeamNotFoundError) {
    return ApiError.of('NOT_FOUND', 'Team not found.', { teamId: err.teamId });
  }
  return err;
}

/**
 * Build the team-leader router. Both routes require leadership of the team named
 * by `:id` (R15) — enforced server-side, independent of the admin routes. The
 * store is injected for testability; production uses {@link DbTeamLeaderStore}.
 */
export function createTeamLeaderRouter(store: TeamLeaderStore): Router {
  const router = Router();
  const guardLeaderOfThisTeam = requireTeamLeadership('id');
  router.get('/teams/:id', guardLeaderOfThisTeam, createGetTeamHandler(store));
  router.patch('/teams/:id', guardLeaderOfThisTeam, createUpdateTeamHandler(store));
  return router;
}

/** Production team-leader router, wired to the Postgres-backed store. */
export const teamLeaderRouter: Router = createTeamLeaderRouter(
  new DbTeamLeaderStore(),
);
