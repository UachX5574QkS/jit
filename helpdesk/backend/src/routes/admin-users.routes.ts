import { Router, type RequestHandler } from 'express';
import { requireAdmin } from '../middleware/authorize.js';
import {
  DbAdminUsersStore,
  type AdminUser,
  type AdminUsersStore,
} from './admin-users.store.js';

/**
 * `GET /api/admin/users` — the leader-picker source for the Tool-Administrator
 * Teams screen (design: "Administration"; R13.2, R13.3).
 *
 *   GET /api/admin/users → { users: AdminUserView[] }
 *
 * Creating a team and changing a team's leader both take a numeric
 * `teamLeaderId`; this read supplies the candidate people (id + display name)
 * so the admin UI can present a leader drop-down.
 *
 * ── Authorisation (R13.1) ────────────────────────────────────────────────────
 * Administrator-only: the route mounts {@link requireAdmin} ahead of the
 * handler, so a non-administrator is rejected with `FORBIDDEN` before any work
 * happens. This is the server-side enforcement point; the frontend hiding the
 * Administer tiles is UX only. No password material is ever returned (R1.5).
 *
 * ── Dependency injection ─────────────────────────────────────────────────────
 * The handler depends on the narrow {@link AdminUsersStore} so it unit-tests
 * with an in-memory fake (no database). Production wiring uses
 * {@link DbAdminUsersStore}.
 */

/** The public JSON view of a person for the leader drop-down. */
export interface AdminUserView {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
}

/** Serialise a stored {@link AdminUser} into its public view (identity today). */
export function serializeAdminUser(user: AdminUser): AdminUserView {
  return { id: user.id, username: user.username, displayName: user.displayName };
}

/** `GET /admin/users` — list every person for the leader drop-down (R13.2/13.3). */
export function createAdminUsersListHandler(store: AdminUsersStore): RequestHandler {
  return (_req, res, next) => {
    void (async () => {
      const users = await store.list();
      res.status(200).json({ users: users.map(serializeAdminUser) });
    })().catch(next);
  };
}

/**
 * Build the admin-users router (mounted at `/admin/users`). The single route is
 * administrator-only via {@link requireAdmin}. The store is injected for
 * testability; production uses {@link DbAdminUsersStore}.
 */
export function createAdminUsersRouter(store: AdminUsersStore): Router {
  const router = Router();
  router.get('/', requireAdmin, createAdminUsersListHandler(store));
  return router;
}

/** Production admin-users router, wired to the Postgres-backed store. */
export const adminUsersRouter: Router = createAdminUsersRouter(new DbAdminUsersStore());
