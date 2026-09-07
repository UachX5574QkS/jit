import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { API_CONFIG } from '../../core/http/api-config';

/**
 * Typed client for the Tool-Administrator team endpoints (design:
 * "Administration" — `POST/GET/PATCH /api/admin/teams`; R13, R20.2), plus the
 * leader-picker source (`GET /api/admin/users`; R13.2/13.3). Feature code talks
 * to this service, never to `HttpClient` directly, so the REST contract is the
 * only coupling to the backend (design: "Data access").
 *
 *   • {@link listTeams}    GET   /api/admin/teams          (R13.3)
 *   • {@link listUsers}    GET   /api/admin/users          (R13.2/13.3)
 *   • {@link createTeam}   POST  /api/admin/teams          (R13.2)
 *   • {@link changeLeader} PATCH /api/admin/teams/:id       (R13.3)
 *   • {@link closeTeam}    PATCH /api/admin/teams/:id       (R13.3, R20.2)
 *
 * Errors are mapped to {@link ApiError} by the shared error interceptor, so the
 * screen branches on the code — notably `CONFLICT_OPEN_REQUESTS` when a close is
 * blocked by non-closed requests (R20.2) and `FORBIDDEN` if a non-admin somehow
 * reaches an endpoint (R13.1).
 */

/** The public JSON view of a team returned by `/api/admin/teams` (R13.3). */
export interface TeamView {
  readonly id: number;
  readonly title: string;
  readonly description: string | null;
  readonly teamLeaderId: number;
  readonly isClosed: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A person for the leader drop-down, from `/api/admin/users` (R13.2/13.3). */
export interface AdminUserView {
  readonly id: number;
  readonly username: string;
  readonly displayName: string;
}

/** Body for creating a team (R13.2). */
export interface CreateTeamRequest {
  readonly title: string;
  readonly description?: string | null;
  readonly teamLeaderId: number;
}

@Injectable({ providedIn: 'root' })
export class TeamAdminService {
  private readonly http = inject(HttpClient);
  private readonly apiConfig = inject(API_CONFIG);

  private get base(): string {
    return this.apiConfig.baseUrl;
  }

  /** List every team (open and closed) for the admin table (R13.3). */
  listTeams(): Observable<TeamView[]> {
    return this.http
      .get<{ teams: TeamView[] }>(`${this.base}/admin/teams`)
      .pipe(map((res) => res.teams));
  }

  /** List the people who can be assigned as a team leader (R13.2/13.3). */
  listUsers(): Observable<AdminUserView[]> {
    return this.http
      .get<{ users: AdminUserView[] }>(`${this.base}/admin/users`)
      .pipe(map((res) => res.users));
  }

  /** Create a team and assign its leader (R13.2). */
  createTeam(body: CreateTeamRequest): Observable<TeamView> {
    return this.http.post<TeamView>(`${this.base}/admin/teams`, body);
  }

  /** Change a team's leader/owner (R13.3). */
  changeLeader(teamId: number, teamLeaderId: number): Observable<TeamView> {
    return this.http.patch<TeamView>(`${this.base}/admin/teams/${teamId}`, { teamLeaderId });
  }

  /**
   * Close a team (R13.3). The backend rejects with `CONFLICT_OPEN_REQUESTS`
   * when the team still has non-closed requests (R20.2); the caller handles
   * that mapped {@link ApiError} gracefully.
   */
  closeTeam(teamId: number): Observable<TeamView> {
    return this.http.patch<TeamView>(`${this.base}/admin/teams/${teamId}`, { isClosed: true });
  }
}
