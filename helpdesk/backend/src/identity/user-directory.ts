import type { Role } from './current-user.js';
import type { Queryable } from '../db/query.js';
import { query } from '../db/query.js';
import { pool } from '../db/pool.js';

/**
 * Loads the directory of people for the development login drop-down (design:
 * "Auth & identity" — `GET /api/auth/users` dev-only; R1.2).
 *
 * ── Why a dedicated loader ───────────────────────────────────────────────────
 * The login drop-down is a DEVELOPMENT convenience: it lists every created
 * person so a developer can pick an account to log in as, formatted as
 * "`<username>` `<firstname>` (`<role>`) `<surname>`" (R1.2). It needs the
 * display fields (`username`, `firstName`, `surname`) plus enough membership
 * facts to derive each person's additive role superset and choose the single
 * highest-privilege role for the label.
 *
 * Like the other identity loaders this is an interface so the endpoint's unit
 * tests can inject an in-memory fake (keeping them database-free, matching the
 * project's test style) and so the storage boundary stays behind the
 * parameterised data-access layer (R22.4).
 *
 * NEVER select `password_hash` here — a directory entry must not carry it, and
 * the drop-down never needs it (design: "Passwords", R1.5).
 */
export interface DirectoryUser {
  /** 8-digit `app_user.username`. */
  readonly username: string;
  readonly firstName: string;
  readonly surname: string;
  /** The additive role superset (R1.8) this person holds. */
  readonly roles: ReadonlySet<Role>;
}

export interface UserDirectoryLoader {
  /**
   * Load every created person with the fields needed to render the login
   * drop-down. Ordering is not guaranteed by the contract; callers that need a
   * stable order should sort.
   */
  loadAll(): Promise<DirectoryUser[]>;
}

/**
 * Highest-privilege-first ordering of roles (design: R1.2 role selection).
 *
 * Roles are additive — a person may hold several at once (R1.8) — but the
 * drop-down label shows a SINGLE role. When a person holds more than one, the
 * label uses the most privileged, resolved by this ordering:
 *
 *   ADMINISTRATOR > TEAM_LEADER > SUPPORT_MEMBER > USER
 *
 * `USER` is the floor: every resolvable principal is at least a user, so the
 * ordering always yields a role.
 */
export const ROLE_PRIORITY: readonly Role[] = [
  'ADMINISTRATOR',
  'TEAM_LEADER',
  'SUPPORT_MEMBER',
  'USER',
];

/** Human-readable label for each role, as shown in the drop-down (R1.2). */
export const ROLE_LABELS: Readonly<Record<Role, string>> = {
  ADMINISTRATOR: 'Administrator',
  TEAM_LEADER: 'Team Leader',
  SUPPORT_MEMBER: 'Support Member',
  USER: 'User',
};

/**
 * Choose the single highest-privilege role from an additive role superset,
 * using {@link ROLE_PRIORITY}. Falls back to `USER` for an (empty) set that
 * should never occur in practice.
 */
export function highestPrivilegeRole(roles: ReadonlySet<Role>): Role {
  return ROLE_PRIORITY.find((role) => roles.has(role)) ?? 'USER';
}

/**
 * Build the drop-down label for a directory user (R1.2):
 *
 *   "`<8-digit-username>` `<firstname>` (`<role>`) `<surname>`"
 *   e.g. "11111111 Jason (Administrator) Hughes"
 *
 * The `<role>` is the human label of the person's highest-privilege role.
 */
export function formatDirectoryLabel(user: DirectoryUser): string {
  const role = ROLE_LABELS[highestPrivilegeRole(user.roles)];
  return `${user.username} ${user.firstName} (${role}) ${user.surname}`;
}

/** Row shape for the directory query. No `password_hash` is ever selected. */
interface DirectoryRow {
  readonly username: string;
  readonly first_name: string;
  readonly surname: string;
  readonly is_admin: boolean;
  readonly leads_team: boolean;
  readonly is_member: boolean;
}

/**
 * Postgres-backed {@link UserDirectoryLoader}. Reads every `app_user` with the
 * membership facts needed to derive each person's role superset — admin-group
 * membership, whether they lead any team, and whether they are a member of any
 * team — through the parameterised data-access layer (R22.4). The explicit
 * column list deliberately omits `password_hash` (R1.5).
 *
 * Role derivation mirrors {@link import('./current-user.js').deriveRoles}:
 * everyone is a `USER`; team membership adds `SUPPORT_MEMBER`; leading a team
 * adds `TEAM_LEADER`; admin-group membership adds `ADMINISTRATOR`.
 */
export class DbUserDirectoryLoader implements UserDirectoryLoader {
  constructor(private readonly db: Queryable = pool) {}

  async loadAll(): Promise<DirectoryUser[]> {
    const rows = await query<DirectoryRow>(
      `SELECT u.username,
              u.first_name,
              u.surname,
              EXISTS (SELECT 1 FROM admin_group a WHERE a.user_id = u.id) AS is_admin,
              EXISTS (SELECT 1 FROM team t WHERE t.team_leader_id = u.id) AS leads_team,
              EXISTS (SELECT 1 FROM team_member m WHERE m.user_id = u.id) AS is_member
         FROM app_user u
        ORDER BY u.username`,
      [],
      this.db,
    );

    return rows.map((row) => {
      const roles = new Set<Role>(['USER']);
      if (row.is_member) {
        roles.add('SUPPORT_MEMBER');
      }
      if (row.leads_team) {
        roles.add('TEAM_LEADER');
      }
      if (row.is_admin) {
        roles.add('ADMINISTRATOR');
      }
      return {
        username: row.username,
        firstName: row.first_name,
        surname: row.surname,
        roles,
      };
    });
  }
}
