import { many, type Queryable } from '../db/query.js';
import { pool } from '../db/pool.js';

/**
 * Data-access layer for `GET /api/support/teams/:id/members` — the assignment
 * drop-down source for the Support detail view (design: "Support side"; R7.2).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * When a support member works a request on the Support detail screen they may
 * assign it to ANY member of the request's team (or unassign it) — "any team
 * member → any team member" (R7.2). The support-side PATCH already validates
 * that the chosen assignee is a member of the request's team, but the UI needs
 * the CANDIDATE list to populate the drop-down. The existing member list lives
 * behind the Team-Leader endpoint (`GET /api/team-leader/teams/:id`), which is
 * leader-only; support members need a read they are actually permitted to make,
 * so this narrow, membership-checked read is added on the Support router.
 *
 * ── Why an interface + a DB implementation ───────────────────────────────────
 * The route handler (support-team-members.routes.ts) depends on this narrow
 * {@link SupportTeamMembersStore} interface, never on `pg` directly, so it
 * unit-tests with an in-memory fake — matching the injectable style used across
 * the request/support stores. The production {@link DbSupportTeamMembersStore}
 * is the only place that talks to Postgres, and it does so exclusively through
 * the parameterised data-access layer (`db/query.ts`): every value travels as a
 * bound placeholder, nothing is interpolated into SQL text (R22.2).
 *
 * ── Authorisation ────────────────────────────────────────────────────────────
 * The read is membership-checked by the ROUTE against `CurrentUser.teamsMemberOf`
 * (a support member may only ever see their own teams' membership); this store
 * simply returns the members of the given team, ordered by display name.
 */

/** One team member candidate for the assignment drop-down (R7.2). */
export interface SupportTeamMember {
  readonly userId: number;
  readonly username: string;
  readonly displayName: string;
}

/** The narrow contract the route handler depends on. */
export interface SupportTeamMembersStore {
  /** Return the members of a team, ordered by display name (R7.2). */
  listMembers(teamId: number): Promise<SupportTeamMember[]>;
}

/** Shape of a member row (team_member joined to app_user). */
interface MemberDbRow {
  user_id: string | number;
  username: string;
  first_name: string;
  surname: string;
}

/** Normalise a DB member row into the API {@link SupportTeamMember}. */
function toMember(row: MemberDbRow): SupportTeamMember {
  return {
    userId: Number(row.user_id),
    username: row.username,
    displayName: `${row.first_name} ${row.surname}`.trim(),
  };
}

/**
 * Postgres-backed {@link SupportTeamMembersStore}. The single read is
 * parameterised; the team id travels as a bound placeholder.
 */
export class DbSupportTeamMembersStore implements SupportTeamMembersStore {
  constructor(private readonly reader: Queryable = pool) {}

  async listMembers(teamId: number): Promise<SupportTeamMember[]> {
    const rows = await many<MemberDbRow>(
      `SELECT tm.user_id      AS user_id,
              au.username     AS username,
              au.first_name   AS first_name,
              au.surname      AS surname
         FROM team_member tm
         JOIN app_user au ON au.id = tm.user_id
        WHERE tm.team_id = $1
        ORDER BY au.surname ASC, au.first_name ASC, tm.user_id ASC`,
      [teamId],
      this.reader,
    );
    return rows.map(toMember);
  }
}
