import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { API_CONFIG } from '../../core/http/api-config';
import { TimezoneService } from '../../core/timezone/timezone.service';
import type { UserStatsResponse } from './user-statistics.service';

/**
 * Typed client for the Team Statistics contract (design: "Statistics" —
 * `GET /api/stats/team` — hierarchy-scoped; R11, R19, R18.3). Feature code talks
 * to this service, never to `HttpClient` directly, so the REST contract is the
 * only coupling to the backend (design: "Data access"). The single method maps
 * the one documented endpoint:
 *
 *   • {@link getTeamStats}  GET /api/stats/team?tz=<IANA>   (R11, R18.3)
 *
 * ── Same shape as User Statistics ────────────────────────────────────────────
 * Team Statistics returns the SAME four datasets as User Statistics (task 8.2 /
 * design), just scoped to the caller's downward management hierarchy rather than
 * their own requests. The payload shape is therefore identical, so this service
 * reuses {@link UserStatsResponse} verbatim (and, by extension, the shared
 * dashboard view-model helpers) rather than duplicating the type surface.
 *
 * ── Scope (R11.1, R19) ───────────────────────────────────────────────────────
 * The population — the caller's direct reports and, recursively, their reports —
 * is resolved entirely SERVER-SIDE from `req.currentUser.id`, honouring the
 * area-manager cutoff and cycle guard (R19). The client never names a manager;
 * a leaf manager with no reports simply gets empty datasets.
 *
 * ── Timezone (R11.2 → R10.1, R18.3) ──────────────────────────────────────────
 * The "by month" buckets are computed server-side in the viewer's timezone. The
 * client passes its effective timezone as `?tz=<IANA>` via the shared
 * {@link TimezoneService} (browser zone first, then the user's stored zone, then
 * UTC), so the backend's `AT TIME ZONE` bucketing matches what the local-date
 * pipe renders on the same screen.
 */

/** The Team Statistics payload; identical in shape to User Statistics (R11.1). */
export type TeamStatsResponse = UserStatsResponse;

@Injectable({ providedIn: 'root' })
export class TeamStatisticsService {
  private readonly http = inject(HttpClient);
  private readonly apiConfig = inject(API_CONFIG);
  private readonly timezone = inject(TimezoneService);

  private get base(): string {
    return this.apiConfig.baseUrl;
  }

  /**
   * Fetch the Team Statistics datasets for the current user's downward
   * hierarchy (`GET /api/stats/team?tz=<IANA>`, R11, R18.3). The viewer's
   * effective timezone is always sent as `?tz` so the month buckets align with
   * the dates rendered on the same screen.
   */
  getTeamStats(): Observable<TeamStatsResponse> {
    const params = new HttpParams().set('tz', this.timezone.resolve());
    return this.http.get<TeamStatsResponse>(`${this.base}/stats/team`, { params });
  }
}
