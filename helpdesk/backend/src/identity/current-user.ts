/**
 * The `CurrentUser` — the single resolved identity the rest of the backend
 * reads (design: cross-cutting "Identity resolution", R1.3, R1.7, R22.4).
 *
 * ── Why a single shape ───────────────────────────────────────────────────────
 * Every request is resolved to exactly one `CurrentUser`. Feature code and the
 * authorisation middleware ONLY read this object; they never look at cookies,
 * tokens, or the database directly. That is what lets the authentication source
 * be swapped from the development username/password login to IDCS later without
 * touching feature code (R1.7, R22.4): only the {@link AuthSource} that produces
 * the principal reference changes, not the `CurrentUser` contract.
 *
 * ── Roles are additive ───────────────────────────────────────────────────────
 * A single person may simultaneously be a user, a support member (of one or
 * more teams), a team leader (of one or more teams), and/or an administrator.
 * The role set here is the SUPERSET of those memberships (design: "AuthZ",
 * R1.8, roles-additive). Menus and permitted actions are derived from this
 * superset — server-side for enforcement, client-side for UX only.
 */

/**
 * The distinct roles a person can hold. A person's effective roles are the
 * union (superset) of every role their memberships confer (R1.8).
 *
 *   • USER          — everyone who can log in can raise/track requests.
 *   • SUPPORT_MEMBER — a member of at least one team (works that team's queue).
 *   • TEAM_LEADER    — the recorded leader of at least one team.
 *   • ADMINISTRATOR  — a member of the administrator group.
 */
export type Role = 'USER' | 'SUPPORT_MEMBER' | 'TEAM_LEADER' | 'ADMINISTRATOR';

/**
 * The raw identity facts loaded for a resolved principal, before role
 * derivation. This is the source-agnostic input to {@link buildCurrentUser}:
 * the development session loader and a future IDCS loader both populate this
 * same structure, so role logic is written once and shared.
 */
export interface UserIdentity {
  /** Surrogate `app_user.id`. */
  readonly id: number;
  /** 8-digit `app_user.username`. */
  readonly username: string;
  readonly firstName: string;
  readonly surname: string;
  /** Preferred IANA timezone, or `null` to fall back to the browser (R18.2). */
  readonly timezone: string | null;
  /** Ids of teams this person leads (`team.team_leader_id`). */
  readonly teamsLed: ReadonlyArray<number>;
  /** Ids of teams this person is a member of (`team_member`). */
  readonly teamsMemberOf: ReadonlyArray<number>;
  /** Whether this person is in the administrator group (`admin_group`). */
  readonly isAdmin: boolean;
}

/**
 * The resolved current user the rest of the application reads. Immutable by
 * construction (all fields `readonly`).
 */
export interface CurrentUser {
  readonly id: number;
  readonly username: string;
  /** "firstname surname" display name (R1.2 glossary). */
  readonly displayName: string;
  /** The superset of the person's roles (R1.8, roles-additive). */
  readonly roles: ReadonlySet<Role>;
  /** Team ids this person leads. */
  readonly teamsLed: ReadonlyArray<number>;
  /** Team ids this person is a member of. */
  readonly teamsMemberOf: ReadonlyArray<number>;
  /** Convenience mirror of `roles.has('ADMINISTRATOR')`. */
  readonly isAdmin: boolean;
  /** Preferred timezone, or `null` to fall back to the browser (R18.2). */
  readonly timezone: string | null;
}

/**
 * Derive the additive role superset from raw identity facts (R1.8).
 *
 * `USER` is always present: any resolved principal can raise/track requests.
 * The remaining roles are added only when the corresponding membership exists,
 * so the set is exactly the union of what the person's memberships confer.
 */
export function deriveRoles(identity: UserIdentity): Set<Role> {
  const roles = new Set<Role>(['USER']);
  if (identity.teamsMemberOf.length > 0) {
    roles.add('SUPPORT_MEMBER');
  }
  if (identity.teamsLed.length > 0) {
    roles.add('TEAM_LEADER');
  }
  if (identity.isAdmin) {
    roles.add('ADMINISTRATOR');
  }
  return roles;
}

/**
 * Build the immutable {@link CurrentUser} from source-agnostic identity facts.
 *
 * This is a pure function: given the same facts it always yields the same
 * `CurrentUser`, regardless of whether those facts came from the development
 * session or a future IDCS token. The display name is composed as
 * "firstname surname"; the role superset is derived by {@link deriveRoles};
 * `isAdmin` is kept consistent with the presence of the `ADMINISTRATOR` role;
 * and the team-id arrays are defensively copied and frozen so callers cannot
 * mutate the resolved identity.
 */
export function buildCurrentUser(identity: UserIdentity): CurrentUser {
  const roles = deriveRoles(identity);
  return {
    id: identity.id,
    username: identity.username,
    displayName: `${identity.firstName} ${identity.surname}`.trim(),
    roles,
    teamsLed: Object.freeze([...identity.teamsLed]),
    teamsMemberOf: Object.freeze([...identity.teamsMemberOf]),
    isAdmin: roles.has('ADMINISTRATOR'),
    timezone: identity.timezone,
  };
}

/** True when the current user holds `role` (from the additive superset). */
export function hasRole(user: CurrentUser, role: Role): boolean {
  return user.roles.has(role);
}

/** True when the current user leads the given team. */
export function leadsTeam(user: CurrentUser, teamId: number): boolean {
  return user.teamsLed.includes(teamId);
}

/** True when the current user is a member of the given team. */
export function isMemberOfTeam(user: CurrentUser, teamId: number): boolean {
  return user.teamsMemberOf.includes(teamId);
}
