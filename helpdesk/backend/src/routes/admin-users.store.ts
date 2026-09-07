import { many, type Queryable } from '../db/query.js';
import { pool } from '../db/pool.js';

/**
 * Data-access layer for `GET /api/admin/users` — the candidate-people source
 * the Tool-Administrator Teams screen uses to pick a team leader/owner
 * (design: "Administration"; R13.2, R13.3).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Creating a team assigns it a leader and changing a team re-assigns the
 * leader, both keyed by the numeric `app_user.id` (`teamLeaderId`, R13.2–13.3).
 * The admin screen therefore needs the list of people WITH their ids to build
 * the leader drop-down. The only other people-list read (`GET /api/auth/users`)
 * is a DEV-ONLY, pre-login convenience that returns usernames but not ids, so
 * an administrator-scoped, authenticated read is added here.
 *
 * ── Why an interface + a DB implementation ───────────────────────────────────
 * The route handler depends on this narrow {@link AdminUsersStore} interface,
 * never on `pg` directly, so it unit-tests with an in-memory fake — matching
 * the injectable style used across the other stores. The production
 * {@link DbAdminUsersStore} is the only place that talks to Postgres, through
 * the parameterised data-access layer (`db/query.ts`); no password material is
 * ever selected (R1.5).
 *
 * ── Authorisation ────────────────────────────────────────────────────────────
 * The route mounts {@link requireAdmin} ahead of the handler, so only members
 * of the administrator group ever reach this read (R13.1).
 */

/** One person for the leader drop-down (id + display fields; never a hash). */
export interface AdminUser {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
}

/** The narrow contract the route handler depends on. */
export interface AdminUsersStore {
  /** Return every person, ordered by display name (surname, first name). */
  list(): Promise<AdminUser[]>;
}

/** Shape of an `app_user` row for this read (no `password_hash`). */
interface AdminUserDbRow {
  id: string | number;
  username: string;
  first_name: string;
  surname: string;
}

/** Normalise a DB row into the API {@link AdminUser}. */
function toAdminUser(row: AdminUserDbRow): AdminUser {
  return {
    id: Number(row.id),
    username: row.username,
    displayName: `${row.first_name} ${row.surname}`.trim(),
  };
}

/**
 * Postgres-backed {@link AdminUsersStore}. The single read is parameterised
 * (no interpolation) and deliberately omits `password_hash` (R1.5).
 */
export class DbAdminUsersStore implements AdminUsersStore {
  constructor(private readonly reader: Queryable = pool) {}

  async list(): Promise<AdminUser[]> {
    const rows = await many<AdminUserDbRow>(
      `SELECT id, username, first_name, surname
         FROM app_user
        ORDER BY surname ASC, first_name ASC, id ASC`,
      [],
      this.reader,
    );
    return rows.map(toAdminUser);
  }
}
