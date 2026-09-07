/**
 * Frontend mirror of the backend `CurrentUser` view (design: "Auth & identity",
 * R1.7). The `GET /api/auth/me` endpoint serialises the resolved principal to
 * this exact shape — id, username, display name, the additive role superset,
 * teams led, teams member of, isAdmin, and preferred timezone.
 *
 * ── Single identity source ───────────────────────────────────────────────────
 * This is the only identity type feature code reads. Because the backend
 * resolves the principal behind a single abstraction (dev session cookie now,
 * IDCS later), swapping the authentication source never changes this contract
 * (R1.7).
 */

/**
 * The distinct roles a person can hold. A person's effective roles are the
 * union (superset) of every role their memberships confer (R1.8):
 *
 *   • USER           — everyone who can log in can raise/track requests.
 *   • SUPPORT_MEMBER — a member of at least one team.
 *   • TEAM_LEADER    — the recorded leader of at least one team.
 *   • ADMINISTRATOR  — a member of the administrator group.
 */
export type Role = 'USER' | 'SUPPORT_MEMBER' | 'TEAM_LEADER' | 'ADMINISTRATOR';

/** Every role code, useful for validation/iteration. */
export const ALL_ROLES: readonly Role[] = [
  'USER',
  'SUPPORT_MEMBER',
  'TEAM_LEADER',
  'ADMINISTRATOR',
];

/**
 * The JSON shape returned by `GET /api/auth/me`. `roles` arrives as a
 * (sorted) array of role codes; the {@link CurrentUserService} converts it into
 * a `Set` for cheap membership checks.
 */
export interface CurrentUserDto {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
  readonly roles: string[];
  readonly teamsLed: number[];
  readonly teamsMemberOf: number[];
  readonly isAdmin: boolean;
  readonly timezone: string | null;
}

/**
 * The resolved current user the Angular app reads. Immutable by construction;
 * `roles` is a `Set` so role checks are O(1).
 */
export interface CurrentUser {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
  readonly roles: ReadonlySet<Role>;
  readonly teamsLed: readonly number[];
  readonly teamsMemberOf: readonly number[];
  readonly isAdmin: boolean;
  readonly timezone: string | null;
}

/** True iff `value` is one of the known {@link Role} codes. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ALL_ROLES as readonly string[]).includes(value);
}

/**
 * Build the immutable {@link CurrentUser} from the `/auth/me` DTO. Unknown role
 * strings are ignored defensively so a future backend role the frontend does
 * not model cannot break identity resolution.
 */
export function currentUserFromDto(dto: CurrentUserDto): CurrentUser {
  const roles = new Set<Role>(dto.roles.filter(isRole));
  return {
    id: dto.id,
    username: dto.username,
    displayName: dto.displayName,
    roles,
    teamsLed: [...dto.teamsLed],
    teamsMemberOf: [...dto.teamsMemberOf],
    // Keep `isAdmin` consistent with the role set even if the DTO disagrees.
    isAdmin: dto.isAdmin || roles.has('ADMINISTRATOR'),
    timezone: dto.timezone,
  };
}
