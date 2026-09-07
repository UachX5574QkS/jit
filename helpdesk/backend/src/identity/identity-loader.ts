import type { UserIdentity } from './current-user.js';
import type { Queryable } from '../db/query.js';
import { one, query } from '../db/query.js';
import { pool } from '../db/pool.js';

/**
 * Loads the raw identity facts for a resolved principal id (design: data model
 * "Identity & org", "Teams & membership").
 *
 * The loader is the boundary between the identity abstraction and the database.
 * It is expressed as an interface so tests can inject an in-memory fake (keeping
 * identity unit tests database-free, matching the project's test style) and so
 * a future IDCS deployment could source some facts differently while still
 * producing the same {@link UserIdentity} shape.
 *
 * NEVER select `password_hash` here — the resolved identity must not carry it
 * (design: "Passwords", R1.5).
 */
export interface UserIdentityLoader {
  /**
   * Load identity facts for `principalId`, or `null` when no such user exists
   * (e.g. a stale session cookie for a deleted account).
   */
  load(principalId: number): Promise<UserIdentity | null>;
}

/** Row shape for the core `app_user` lookup (no `password_hash`). */
interface AppUserRow {
  readonly id: number;
  readonly username: string;
  readonly first_name: string;
  readonly surname: string;
  readonly timezone: string | null;
}

/** Row shape for team-id membership/leadership lookups. */
interface TeamIdRow {
  readonly team_id: number;
}

/** Row shape for the admin-group existence check. */
interface AdminRow {
  readonly is_admin: boolean;
}

/**
 * Postgres-backed {@link UserIdentityLoader}. Reads the core user record, the
 * teams they lead, the teams they are a member of, and their admin-group
 * membership — everything role derivation needs — through the parameterised
 * data-access layer (R22.4). All statements use `$1` placeholders; no value is
 * ever interpolated into SQL.
 */
export class DbUserIdentityLoader implements UserIdentityLoader {
  constructor(private readonly db: Queryable = pool) {}

  async load(principalId: number): Promise<UserIdentity | null> {
    // Core identity. Explicit column list deliberately omits password_hash.
    const user = await one<AppUserRow>(
      `SELECT id, username, first_name, surname, timezone
         FROM app_user
        WHERE id = $1`,
      [principalId],
      this.db,
    );
    if (!user) {
      return null;
    }

    // Teams led, teams a member of, and admin membership. Independent reads.
    const [ledRows, memberRows, adminRows] = await Promise.all([
      query<TeamIdRow>(
        `SELECT id AS team_id FROM team WHERE team_leader_id = $1`,
        [principalId],
        this.db,
      ),
      query<TeamIdRow>(
        `SELECT team_id FROM team_member WHERE user_id = $1`,
        [principalId],
        this.db,
      ),
      query<AdminRow>(
        `SELECT EXISTS (
            SELECT 1 FROM admin_group WHERE user_id = $1
         ) AS is_admin`,
        [principalId],
        this.db,
      ),
    ]);

    return {
      id: user.id,
      username: user.username,
      firstName: user.first_name,
      surname: user.surname,
      timezone: user.timezone,
      teamsLed: ledRows.map((r) => r.team_id),
      teamsMemberOf: memberRows.map((r) => r.team_id),
      isAdmin: adminRows[0]?.is_admin ?? false,
    };
  }
}
