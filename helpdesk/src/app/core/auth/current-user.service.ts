import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { Observable, tap } from 'rxjs';
import { API_CONFIG } from '../http/api-config';
import {
  type CurrentUser,
  type CurrentUserDto,
  type Role,
  currentUserFromDto,
} from './current-user.model';

/**
 * The single identity source for the Angular app (design:
 * "core/CurrentUserService", R1.7).
 *
 * ── One resolution point ─────────────────────────────────────────────────────
 * Feature code, route guards, and the sidebar all read the current user from
 * here — never from cookies, tokens, or `/auth/me` directly. The service loads
 * the resolved principal from `GET /api/auth/me` and exposes it as a signal
 * (`user`) plus derived signals (`roles`, `isAuthenticated`). Because the
 * backend resolves identity behind a single abstraction (dev session now, IDCS
 * later), nothing here changes when the authentication source is swapped (R1.7).
 *
 * ── Additive roles ───────────────────────────────────────────────────────────
 * The current user's roles are the union (superset) of every role their
 * memberships confer (R1.8). The role-checking helpers below (`hasRole`,
 * `hasAnyRole`, `isAdmin`, `leadsTeam`, `isMemberOfTeam`) read that superset so
 * a person with several roles is treated as holding all of them.
 */
@Injectable({ providedIn: 'root' })
export class CurrentUserService {
  private readonly http = inject(HttpClient);
  private readonly apiConfig = inject(API_CONFIG);

  private readonly _user = signal<CurrentUser | null>(null);
  private readonly _loaded = signal(false);

  /** The resolved current user, or `null` when not authenticated/loaded. */
  readonly user = this._user.asReadonly();

  /** True once an initial load attempt has completed (success or failure). */
  readonly loaded = this._loaded.asReadonly();

  /** True when a current user is resolved. */
  readonly isAuthenticated = computed(() => this._user() !== null);

  /** The current user's additive role superset (empty when unauthenticated). */
  readonly roles = computed<ReadonlySet<Role>>(() => this._user()?.roles ?? new Set<Role>());

  /** Convenience: true when the current user is an administrator. */
  readonly isAdmin = computed(() => this._user()?.isAdmin ?? false);

  /**
   * Load the current user from `GET /api/auth/me` and store it. On success the
   * `user` signal is populated; the caller (e.g. an app initializer or login
   * flow) subscribes to trigger the request. Errors propagate — a 401 is mapped
   * by the interceptor and routed to login — but this service defensively
   * clears the user and marks itself loaded so guards fail closed.
   */
  load(): Observable<CurrentUserDto> {
    return this.http.get<CurrentUserDto>(`${this.apiConfig.baseUrl}/auth/me`).pipe(
      tap({
        next: (dto) => {
          this._user.set(currentUserFromDto(dto));
          this._loaded.set(true);
        },
        error: () => {
          this._user.set(null);
          this._loaded.set(true);
        },
      }),
    );
  }

  /** Directly set (or clear) the resolved user, e.g. after login/logout. */
  setUser(user: CurrentUser | null): void {
    this._user.set(user);
    this._loaded.set(true);
  }

  /** Clear the resolved identity (e.g. on logout or a 401). */
  clear(): void {
    this._user.set(null);
    this._loaded.set(true);
  }

  /** Snapshot accessor for non-reactive callers (e.g. guards). */
  snapshot(): CurrentUser | null {
    return this._user();
  }

  // ── Role-checking helpers (read the additive superset, R1.7/R1.8) ──────────

  /** True when the current user holds `role`. */
  hasRole(role: Role): boolean {
    return this._user()?.roles.has(role) ?? false;
  }

  /** True when the current user holds at least one of `roles`. */
  hasAnyRole(roles: readonly Role[]): boolean {
    const user = this._user();
    if (!user) {
      return false;
    }
    return roles.some((role) => user.roles.has(role));
  }

  /** True when the current user holds every role in `roles`. */
  hasAllRoles(roles: readonly Role[]): boolean {
    const user = this._user();
    if (!user) {
      return false;
    }
    return roles.every((role) => user.roles.has(role));
  }

  /** True when the current user leads the given team. */
  leadsTeam(teamId: number): boolean {
    return this._user()?.teamsLed.includes(teamId) ?? false;
  }

  /** True when the current user is a member of the given team. */
  isMemberOfTeam(teamId: number): boolean {
    return this._user()?.teamsMemberOf.includes(teamId) ?? false;
  }
}
