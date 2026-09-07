import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, switchMap } from 'rxjs';
import { API_CONFIG } from '../http/api-config';
import { CurrentUserService } from './current-user.service';
import { type CurrentUser, type CurrentUserDto, currentUserFromDto } from './current-user.model';

/**
 * A directory entry returned by `GET /api/auth/users` for the development login
 * drop-down (design: `GET /api/auth/users`, R1.2).
 *
 * The backend serialises each created person with the individual fields AND a
 * preformatted `label` — "`<username>` `<firstname>` (`<role>`) `<surname>`"
 * where `<role>` is the person's single highest-privilege role — so the login
 * screen can render the drop-down directly from `label` (R1.2). No password
 * material is ever included (R1.5).
 */
export interface DirectoryUser {
  readonly username: string;
  readonly firstName: string;
  readonly surname: string;
  /** Highest-privilege role code (ADMINISTRATOR > TEAM_LEADER > SUPPORT_MEMBER > USER). */
  readonly role: string;
  /** Preformatted "`<username>` `<firstname>` (`<role>`) `<surname>`" label (R1.2). */
  readonly label: string;
}

/** The `{ users: [...] }` envelope returned by `GET /api/auth/users`. */
interface DirectoryResponse {
  readonly users: DirectoryUser[];
}

/** The `{ username, password }` body posted to `POST /api/auth/login`. */
export interface LoginCredentials {
  readonly username: string;
  readonly password: string;
}

/**
 * Authentication actions for the login flow (design: "Auth & identity", R1).
 *
 * ── Establish then resolve ───────────────────────────────────────────────────
 * {@link login} posts credentials to `POST /api/auth/login`. On success the
 * backend sets the HTTP-only session cookie (the auth interceptor's
 * `withCredentials` carries it), then this service loads the resolved
 * {@link CurrentUser} via {@link CurrentUserService.load} so the app has its
 * single identity source populated before navigating in (R1.3, R1.7). Invalid
 * credentials are rejected by the backend WITHOUT a session (R1.4); the error
 * propagates as an {@link ApiError} for the login screen to display.
 *
 * ── Dev drop-down ────────────────────────────────────────────────────────────
 * {@link listDirectory} loads the dev-only `GET /api/auth/users` list that
 * populates the login username drop-down (R1.2).
 *
 * Identity is only ever read from {@link CurrentUserService}; this service just
 * performs the login/logout side effects and delegates identity resolution to
 * it, so swapping the dev login for IDCS later leaves feature code untouched
 * (R1.7).
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly apiConfig = inject(API_CONFIG);
  private readonly currentUser = inject(CurrentUserService);

  /**
   * Load the development login drop-down directory from `GET /api/auth/users`
   * (R1.2). The endpoint exists only in development; outside development it 404s
   * and the caller surfaces the error.
   */
  listDirectory(): Observable<DirectoryUser[]> {
    return new Observable<DirectoryUser[]>((subscriber) => {
      const sub = this.http
        .get<DirectoryResponse>(`${this.apiConfig.baseUrl}/auth/users`)
        .subscribe({
          next: (res) => subscriber.next(res.users ?? []),
          error: (err) => subscriber.error(err),
          complete: () => subscriber.complete(),
        });
      return () => sub.unsubscribe();
    });
  }

  /**
   * Establish a session from `credentials`, then resolve and cache the current
   * user (R1.3, R1.7). Emits the resolved {@link CurrentUser}. The login POST
   * returns 204 with no body; the follow-up `GET /api/auth/me` (via
   * {@link CurrentUserService.load}) provides the identity. Any failure — bad
   * credentials (R1.4) or the `/me` load — propagates to the caller.
   */
  login(credentials: LoginCredentials): Observable<CurrentUser> {
    return this.http
      .post<void>(`${this.apiConfig.baseUrl}/auth/login`, {
        username: credentials.username,
        password: credentials.password,
      })
      .pipe(
        switchMap(() => this.currentUser.load()),
        // `load()` populates the service and returns the DTO; re-derive the
        // resolved user so the caller receives the same immutable shape.
        switchMap((dto: CurrentUserDto) => {
          const user = currentUserFromDto(dto);
          return new Observable<CurrentUser>((s) => {
            s.next(user);
            s.complete();
          });
        }),
      );
  }

  /**
   * Clear the session on the backend (`POST /api/auth/logout`) and drop the
   * cached identity locally. Emits once complete.
   */
  logout(): Observable<void> {
    return new Observable<void>((subscriber) => {
      const sub = this.http
        .post<void>(`${this.apiConfig.baseUrl}/auth/logout`, {})
        .subscribe({
          next: () => {
            this.currentUser.clear();
            subscriber.next();
          },
          error: (err) => {
            // Even if the network call fails, drop local identity so the app
            // does not present a stale authenticated state.
            this.currentUser.clear();
            subscriber.error(err);
          },
          complete: () => subscriber.complete(),
        });
      return () => sub.unsubscribe();
    });
  }
}
