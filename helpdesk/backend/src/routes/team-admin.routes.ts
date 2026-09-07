import { Router, type RequestHandler } from 'express';
import { ApiError, errors } from '../middleware/errors.js';
import { requireAdmin } from '../middleware/authorize.js';
import {
  DbTeamAdminStore,
  OpenRequestsConflictError,
  TeamNotFoundError,
  type CreateTeamInput,
  type TeamAdminStore,
  type TeamRow,
  type UpdateTeamInput,
} from './team-admin.store.js';

/**
 * Tool-Administrator team reference-data endpoints (design: "Administration" —
 * `POST/GET/PATCH /api/admin/teams`, R13, R20.2).
 *
 *   POST   /api/admin/teams        create a team + assign a leader (R13.2)
 *   GET    /api/admin/teams        list teams for the admin table    (R13.3)
 *   PATCH  /api/admin/teams/:id    change leader/owner, or close      (R13.3)
 *
 * ── Authorisation ────────────────────────────────────────────────────────────
 * Every route is guarded by {@link requireAdmin} (R13.1) — only members of the
 * administrator group may reach the handlers; anyone else is rejected with the
 * uniform `FORBIDDEN` envelope BEFORE any work happens. This is the server-side
 * enforcement point; the frontend hiding the Administer tiles is UX only.
 *
 * ── The close guard (R20.2) ──────────────────────────────────────────────────
 * Closing a team is refused while it still has any non-closed request. The
 * store performs that check inside the mutation's transaction and raises
 * {@link OpenRequestsConflictError}; this layer maps it to the uniform
 * `CONFLICT_OPEN_REQUESTS` error (409). A closed team keeps all its existing
 * requests (R20.1) — closing only flips `is_closed`, which the New workflow
 * uses to exclude the team from team selection (R13.4).
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 * Handlers depend on the narrow {@link TeamAdminStore} so they unit-test with an
 * in-memory fake (no database), matching the auth-router style. Production
 * wiring uses {@link DbTeamAdminStore}.
 */

/** The public JSON view of a team (camelCase, ISO dates). Mirrors {@link TeamRow}. */
export interface TeamView {
  readonly id: number;
  readonly title: string;
  readonly description: string | null;
  readonly teamLeaderId: number;
  readonly isClosed: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Serialise a store {@link TeamRow} into its public view (identity mapping today). */
export function serializeTeam(row: TeamRow): TeamView {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    teamLeaderId: row.teamLeaderId,
    isClosed: row.isClosed,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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
 * Validate and normalise the create-team body (R13.2). `title` is required and
 * non-blank; `teamLeaderId` is required and a positive integer; `description`
 * is optional (absent/empty → null). Bad input → `VALIDATION_FAILED` (400).
 */
export function readCreateTeamBody(body: unknown): CreateTeamInput {
  const record = (body ?? {}) as Record<string, unknown>;

  const rawTitle = record['title'];
  if (typeof rawTitle !== 'string' || rawTitle.trim() === '') {
    throw errors.validationFailed('A non-empty team title is required.', {
      field: 'title',
    });
  }
  const title = rawTitle.trim();

  const teamLeaderId = toPositiveInt(record['teamLeaderId']);
  if (teamLeaderId === null) {
    throw errors.validationFailed('A valid teamLeaderId is required.', {
      field: 'teamLeaderId',
    });
  }

  const rawDescription = record['description'];
  let description: string | null = null;
  if (rawDescription !== undefined && rawDescription !== null) {
    if (typeof rawDescription !== 'string') {
      throw errors.validationFailed('description must be a string.', {
        field: 'description',
      });
    }
    const trimmed = rawDescription.trim();
    description = trimmed === '' ? null : trimmed;
  }

  return { title, description, teamLeaderId };
}

/**
 * Validate and normalise the update-team body (R13.3). At least one of
 * `teamLeaderId` (positive integer) or `isClosed` (boolean) must be present;
 * an empty patch is rejected with `VALIDATION_FAILED`. Only the supplied fields
 * are returned so the store leaves the others untouched.
 */
export function readUpdateTeamBody(body: unknown): UpdateTeamInput {
  const record = (body ?? {}) as Record<string, unknown>;
  const input: { teamLeaderId?: number; isClosed?: boolean } = {};

  if (record['teamLeaderId'] !== undefined) {
    const teamLeaderId = toPositiveInt(record['teamLeaderId']);
    if (teamLeaderId === null) {
      throw errors.validationFailed('teamLeaderId must be a positive integer.', {
        field: 'teamLeaderId',
      });
    }
    input.teamLeaderId = teamLeaderId;
  }

  if (record['isClosed'] !== undefined) {
    if (typeof record['isClosed'] !== 'boolean') {
      throw errors.validationFailed('isClosed must be a boolean.', {
        field: 'isClosed',
      });
    }
    input.isClosed = record['isClosed'];
  }

  if (input.teamLeaderId === undefined && input.isClosed === undefined) {
    throw errors.validationFailed(
      'Provide at least one of teamLeaderId or isClosed.',
    );
  }

  return input;
}

/** Read the authenticated admin's id (authenticate guarantees `currentUser`). */
function actingUserId(req: { currentUser?: { id: number } }): number {
  const user = req.currentUser;
  if (!user) {
    // Defensive: requireAdmin runs after authenticate, so this is unreachable.
    throw ApiError.of('FORBIDDEN', 'Authentication required', undefined, 401);
  }
  return user.id;
}

/** `POST /admin/teams` — create a team and assign its leader (R13.2). */
export function createCreateTeamHandler(store: TeamAdminStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const input = readCreateTeamBody(req.body);
      const row = await store.create(input, actingUserId(req));
      res.status(201).json(serializeTeam(row));
    })().catch(next);
  };
}

/** `GET /admin/teams` — list all teams for the admin table (R13.3). */
export function createListTeamsHandler(store: TeamAdminStore): RequestHandler {
  return (_req, res, next) => {
    void (async () => {
      const rows = await store.list();
      res.status(200).json({ teams: rows.map(serializeTeam) });
    })().catch(next);
  };
}

/**
 * `PATCH /admin/teams/:id` — change leader/owner and/or close (R13.3). Closing
 * is guarded by open requests (R20.2): a conflict is surfaced as the uniform
 * `CONFLICT_OPEN_REQUESTS` (409); an unknown id is a 404.
 */
export function createUpdateTeamHandler(store: TeamAdminStore): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const teamId = toPositiveInt((req.params as Record<string, unknown>)['id']);
      if (teamId === null) {
        throw errors.validationFailed('A valid team id is required.', {
          field: 'id',
        });
      }
      const input = readUpdateTeamBody(req.body);
      try {
        const row = await store.update(teamId, input, actingUserId(req));
        res.status(200).json(serializeTeam(row));
      } catch (err) {
        if (err instanceof OpenRequestsConflictError) {
          throw errors.conflictOpenRequests(
            'Cannot close a team with non-closed requests.',
            { teamId: err.teamId, openRequestCount: err.openRequestCount },
          );
        }
        if (err instanceof TeamNotFoundError) {
          throw ApiError.of('NOT_FOUND', 'Team not found.', { teamId: err.teamId });
        }
        throw err;
      }
    })().catch(next);
  };
}

/**
 * Build the team-admin router. All routes require the administrator role
 * (R13.1). The store is injected for testability; production uses
 * {@link DbTeamAdminStore}.
 */
export function createTeamAdminRouter(store: TeamAdminStore): Router {
  const router = Router();
  router.post('/teams', requireAdmin, createCreateTeamHandler(store));
  router.get('/teams', requireAdmin, createListTeamsHandler(store));
  router.patch('/teams/:id', requireAdmin, createUpdateTeamHandler(store));
  return router;
}

/** Production team-admin router, wired to the Postgres-backed store. */
export const teamAdminRouter: Router = createTeamAdminRouter(new DbTeamAdminStore());
