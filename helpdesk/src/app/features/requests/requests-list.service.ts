import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { API_CONFIG } from '../../core/http/api-config';

/**
 * Typed client for the user-side Requests list contract (design: "Requests
 * (user side)" — `GET /api/requests?scope=mine|team&hideComplete=&q=`; R4).
 *
 * Feature code talks to this service, never to `HttpClient` directly, so the
 * REST contract is the only coupling to the backend (design: "Data access").
 * The single method maps the one documented endpoint:
 *
 *   • {@link list}  GET /api/requests?scope=&hideComplete=&q=   (R4.1–4.4, R4.9, R19)
 *
 * The backend already computes everything the row needs — the "(Working On)"
 * open-timer flag (`hasOpenTimer`, R4.6), the per-viewer "Updated" indicator
 * (`updatedSinceLastSeen`, R4.8), and the type-level Estimated Effort
 * (`estimatedEffortMinutes`, R4.7) — so the screen renders purely from typed
 * data.
 */

/** The active list scope: the "My Requests / My Team" toggle (R4.3). */
export type RequestScope = 'mine' | 'team';

/** The query the list screen sends to `GET /api/requests` (R4.2–4.4). */
export interface RequestListQuery {
  /** "mine" (My Requests) or "team" (My Team, hierarchy-scoped) — R4.3, R19. */
  readonly scope: RequestScope;
  /** When true, exclude COMPLETE/REJECTED/CANCELLED (R4.4). Defaults true. */
  readonly hideComplete: boolean;
  /** Optional free-text search across in-scope fields (R4.2); blank → none. */
  readonly search: string | null;
}

/**
 * One request row as returned by `GET /api/requests` (camelCase, ISO dates).
 * Mirrors the backend `RequestListRowJson` shape exactly.
 */
export interface RequestListRow {
  readonly id: number;
  readonly taskReference: string;
  readonly jiraNumber: string | null;
  readonly title: string;
  readonly dateRaised: string;
  readonly status: string;
  readonly teamId: number;
  readonly teamTitle: string;
  readonly assignedMemberId: number | null;
  readonly assignedMemberName: string | null;
  readonly lastUpdated: string;
  readonly estimatedStartDate: string | null;
  readonly actualStartDate: string | null;
  /** True when a support member has an open timer and the request is not closed (R4.6). */
  readonly hasOpenTimer: boolean;
  /** Type-level Estimated Effort in minutes, or null when no complete requests (R4.7). */
  readonly estimatedEffortMinutes: number | null;
  /** The viewer's "Updated" indicator — non-internal change since last seen (R4.8). */
  readonly updatedSinceLastSeen: boolean;
}

/** The envelope returned by `GET /api/requests`. */
export interface RequestListResponse {
  readonly scope: RequestScope;
  readonly hideComplete: boolean;
  readonly search: string | null;
  readonly requests: RequestListRow[];
}

@Injectable({ providedIn: 'root' })
export class RequestsListService {
  private readonly http = inject(HttpClient);
  private readonly apiConfig = inject(API_CONFIG);

  private get base(): string {
    return this.apiConfig.baseUrl;
  }

  /**
   * Fetch the Requests list for the active toggle/filters
   * (`GET /api/requests?scope=&hideComplete=&q=`, R4.1–4.4, R4.9, R19).
   *
   * The scope and hide-complete flag are always sent; `q` is sent only when a
   * non-blank search term is present, matching the backend's "blank → no
   * search" contract (R4.2).
   */
  list(query: RequestListQuery): Observable<RequestListRow[]> {
    let params = new HttpParams()
      .set('scope', query.scope)
      .set('hideComplete', String(query.hideComplete));
    const term = query.search?.trim() ?? '';
    if (term !== '') {
      params = params.set('q', term);
    }
    return this.http
      .get<RequestListResponse>(`${this.base}/requests`, { params })
      .pipe(map((res) => res.requests ?? []));
  }
}
