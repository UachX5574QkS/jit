import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { API_CONFIG } from '../../core/http/api-config';

/**
 * Typed client for the Team-Leader team-management endpoints (design:
 * "Administration" — `GET/PATCH /api/team-leader/teams/{id}` — details +
 * membership, leader-of-THIS-team only, member-removal guarded; R15, R20.3).
 *
 *   • {@link getTeam}      GET   /api/team-leader/teams/:id   details + members (R15.2, R15.3)
 *   • {@link updateTeam}   PATCH /api/team-leader/teams/:id   details / membership (R15.2–15.4)
 *   • {@link listOpenTeams} GET  /api/teams?open=true         team titles for the picker
 *
 * Feature code talks to this service, never to `HttpClient` directly, so the
 * REST contract is the only coupling to the backend (design: "Data access").
 *
 * ── Where the picker gets its titles ─────────────────────────────────────────
 * The backend has no leader-scoped "teams I lead" listing; the authoritative
 * per-team read is `GET /api/team-leader/teams/:id`, guarded to the leader of
 * that team. To label the team picker, this service reuses the open-teams read
 * every authenticated user may call (`GET /api/teams?open=true`) and the caller
 * intersects it with {@link CurrentUser.teamsLed}. A team not present there
 * (e.g. closed) can still be loaded by id via {@link getTeam}.
 *
 * Errors are mapped to {@link ApiError} by the shared error interceptor, so the
 * screen branches on the code — notably `CONFLICT_OPEN_REQUESTS` when a member
 * removal is blocked by that member's non-closed requests under the team
 * (R15.4 / R20.3) and `FORBIDDEN` if the caller is not the team's leader (R15).
 */

/** The public JSON view of a team's details (`/api/team-leader/teams/:id`). */
export interface TeamDetailsView {
  readonly id: number;
  readonly title: string;
  readonly description: string | null;
  readonly teamLeaderId: number;
  readonly isClosed: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The public JSON view of a team member. */
export interface TeamMemberView {
  readonly userId: number;
  readonly username: string;
  readonly displayName: string;
}

/** A team with its membership — the GET/PATCH response shape. */
export interface TeamWithMembersView {
  readonly team: TeamDetailsView;
  readonly members: TeamMemberView[];
}

/** A team the current user leads, used to label the picker. */
export interface LeadableTeam {
  readonly id: number;
  readonly title: string;
}

/**
 * Body for updating a team (R15.2–15.4). At least one of these must be
 * meaningful; the backend rejects an empty patch. `addMemberIds` /
 * `removeMemberIds` change membership; `title` / `description` update details.
 */
export interface UpdateTeamRequest {
  readonly title?: string;
  readonly description?: string | null;
  readonly addMemberIds?: number[];
  readonly removeMemberIds?: number[];
}

@Injectable({ providedIn: 'root' })
export class TeamMembershipService {
  private readonly http = inject(HttpClient);
  private readonly apiConfig = inject(API_CONFIG);

  private get base(): string {
    return this.apiConfig.baseUrl;
  }

  /** Load a team's details and membership (leader-of-this-team only, R15.2/15.3). */
  getTeam(teamId: number): Observable<TeamWithMembersView> {
    return this.http.get<TeamWithMembersView>(`${this.base}/team-leader/teams/${teamId}`);
  }

  /**
   * Update a team's details and/or membership (R15.2–15.4). Member removal may
   * be refused with `CONFLICT_OPEN_REQUESTS` (R20.3); the caller handles that
   * mapped {@link ApiError} gracefully.
   */
  updateTeam(teamId: number, body: UpdateTeamRequest): Observable<TeamWithMembersView> {
    return this.http.patch<TeamWithMembersView>(
      `${this.base}/team-leader/teams/${teamId}`,
      body,
    );
  }

  /**
   * The non-closed teams every authenticated user may read, used to label the
   * team picker (the caller intersects with the leader's `teamsLed`). Titles
   * only — the authoritative membership read is {@link getTeam}.
   */
  listOpenTeams(): Observable<LeadableTeam[]> {
    return this.http
      .get<{ teams: LeadableTeam[] }>(`${this.base}/teams`, {
        params: new HttpParams().set('open', 'true'),
      })
      .pipe(map((res) => res.teams.map((t) => ({ id: t.id, title: t.title }))));
  }
}
