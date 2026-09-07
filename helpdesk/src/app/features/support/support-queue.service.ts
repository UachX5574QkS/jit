import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { API_CONFIG } from '../../core/http/api-config';

/**
 * Typed client for the Support-queue list contract (design: "Support side" —
 * `GET /api/support/requests?team=&scope=mine|team&hideComplete=&
 * showUnassigned=&q=`; R6).
 *
 * Feature code talks to this service, never to `HttpClient` directly, so the
 * REST contract is the only coupling to the backend (design: "Data access").
 * The single method maps the one documented endpoint:
 *
 *   • {@link list}  GET /api/support/requests?team=&scope=&hideComplete=&showUnassigned=&q=  (R6)
 *
 * The backend already computes everything a row needs — the "(Working On)"
 * open-timer flag (`hasOpenTimer`, R4.6), the per-viewer "Updated" indicator
 * (`updatedSinceLastSeen`, R7.5–7.6), and the type-level Estimated Effort
 * (`estimatedEffortMinutes`, R4.7) — so the screen renders purely from typed
 * data, mirroring the Requests screen columns (R6.7).
 */

/** The active queue scope: the "My Queue / Team Queue" toggle (R6.4). */
export type SupportScope = 'mine' | 'team';

/**
 * The "Team" drop-down selection (R6.3): "all" means every team the user is in;
 * a numeric team id means that one team (membership-checked server-side).
 */
export type SupportTeamSelection = 'all' | number;

/** The query the Support screen sends to `GET /api/support/requests` (R6). */
export interface SupportQueueQuery {
  /** The "Team" drop-down: "all" or a specific team id (R6.3). */
  readonly team: SupportTeamSelection;
  /** "mine" (My Queue) or "team" (Team Queue) — R6.4. */
  readonly scope: SupportScope;
  /** When true, exclude COMPLETE/CANCELLED/REJECTED (R6.5). Defaults true. */
  readonly hideComplete: boolean;
  /** When true, include requests with no assigned member (R6.6). Defaults true. */
  readonly showUnassigned: boolean;
  /** Optional free-text search within the active scope (R6.2); blank → none. */
  readonly search: string | null;
}

/**
 * One request row as returned by `GET /api/support/requests` (camelCase, ISO
 * dates). Mirrors the backend `SupportListRowJson` shape exactly — the same
 * columns the Requests screen shows (R6.7).
 */
export interface SupportQueueRow {
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
  /** The viewer's "Updated" indicator — non-internal change since last seen (R7.5–7.6). */
  readonly updatedSinceLastSeen: boolean;
}

/** The envelope returned by `GET /api/support/requests`. */
export interface SupportQueueResponse {
  readonly team: SupportTeamSelection;
  readonly scope: SupportScope;
  readonly hideComplete: boolean;
  readonly showUnassigned: boolean;
  readonly search: string | null;
  readonly requests: SupportQueueRow[];
}

@Injectable({ providedIn: 'root' })
export class SupportQueueService {
  private readonly http = inject(HttpClient);
  private readonly apiConfig = inject(API_CONFIG);

  private get base(): string {
    return this.apiConfig.baseUrl;
  }

  /**
   * Fetch the Support queue for the active drop-down/toggle/filters
   * (`GET /api/support/requests?team=&scope=&hideComplete=&showUnassigned=&q=`, R6).
   *
   * `team`, `scope`, `hideComplete`, and `showUnassigned` are always sent; `q`
   * is sent only when a non-blank search term is present, matching the backend's
   * "blank → no search" contract (R6.2).
   */
  list(query: SupportQueueQuery): Observable<SupportQueueRow[]> {
    let params = new HttpParams()
      .set('team', query.team === 'all' ? 'all' : String(query.team))
      .set('scope', query.scope)
      .set('hideComplete', String(query.hideComplete))
      .set('showUnassigned', String(query.showUnassigned));
    const term = query.search?.trim() ?? '';
    if (term !== '') {
      params = params.set('q', term);
    }
    return this.http
      .get<SupportQueueResponse>(`${this.base}/support/requests`, { params })
      .pipe(map((res) => res.requests ?? []));
  }
}
