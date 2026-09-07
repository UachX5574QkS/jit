import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { API_CONFIG } from '../../core/http/api-config';
import { TimezoneService } from '../../core/timezone/timezone.service';
import type { Status } from '../support/status-transitions';

/**
 * Typed client for the Support Statistics contract (design: "Statistics" —
 * `GET /api/stats/support?team=|all&tz=<IANA>`; R12, R18.3). Feature code talks
 * to this service, never to `HttpClient` directly, so the REST contract is the
 * only coupling to the backend (design: "Data access"). The single method maps
 * the one documented endpoint:
 *
 *   • {@link getSupportStats}  GET /api/stats/support?team=<sel>&tz=<IANA>  (R12)
 *
 * ── Team selector + "All Teams" (R12.1) ──────────────────────────────────────
 * The `team` query param drives the drop-down. `'all'` (the default) covers
 * every team the current user belongs to simultaneously; a numeric team id
 * scopes to that one team. The backend membership-checks any explicit id
 * against `CurrentUser.teamsMemberOf`, so a caller can only ever see their own
 * teams' statistics.
 *
 * ── Timezone (R12.2 → R18.3) ─────────────────────────────────────────────────
 * The status-by-month buckets are computed server-side in the viewer's
 * timezone. The client passes its effective timezone as `?tz=<IANA>` via the
 * shared {@link TimezoneService} (browser zone first, then the user's stored
 * zone, then UTC), so the backend's `AT TIME ZONE` bucketing matches what the
 * local-date pipe renders on the same screen.
 *
 * ── Dense grids ──────────────────────────────────────────────────────────────
 * The backend serialises both tables as DENSE grids across the full
 * (rows × members) cross-product and provides each row's `label` (bare task
 * name for a single team, "Team - Task" across teams), so the dashboard renders
 * a stable matrix without probing for missing cells (R12.3, R12.4).
 */

/** The team drop-down selection sent to / echoed from the backend (R12.1). */
export type SupportStatsTeamSelection = 'all' | number;

/** One (month, status, count) bucket of the status-by-month stacked bar (R12.2). */
export interface StatusMonthBucket {
  /** The month `created_at` falls into in the viewer's timezone, `YYYY-MM`. */
  readonly month: string;
  readonly status: Status;
  readonly count: number;
}

/** One table column — a member of the team(s) in scope (R12.3/R12.4). */
export interface MemberColumn {
  readonly memberId: number;
  readonly memberName: string;
}

/**
 * One table row — a task type in scope (R12.3/R12.4). The backend provides the
 * ready-to-render `label` ("Team - Task" across teams, bare task name for one),
 * plus the ids/titles so the dashboard can group as it likes.
 */
export interface TaskRow {
  readonly taskId: number;
  readonly taskName: string;
  readonly teamId: number;
  readonly teamTitle: string;
  /** The label to render for the row (bare task name, or "Team - Task"). */
  readonly label: string;
}

/** One cell of the assigned-count table: (task row, member column) → count (R12.3). */
export interface AssignedCountCell {
  readonly taskId: number;
  readonly memberId: number;
  readonly count: number;
}

/**
 * One cell of the Accepted→Complete duration table: (task row, member column) →
 * average seconds, or `null` when no request qualifies (R12.4).
 */
export interface AvgDurationCell {
  readonly taskId: number;
  readonly memberId: number;
  readonly avgAcceptedToCompleteSeconds: number | null;
}

/** The full Support Statistics payload returned by `GET /api/stats/support`. */
export interface SupportStatsResponse {
  /** The drop-down selection echoed back ("all" or a team id). */
  readonly team: SupportStatsTeamSelection;
  /** The IANA timezone the month buckets were computed in (echoed by the backend). */
  readonly timezone: string;
  readonly statusByMonth: StatusMonthBucket[];
  /** The shared COLUMNS of both tables — team members in scope. */
  readonly members: MemberColumn[];
  /** The shared ROWS of both tables — task types in scope, with render `label`. */
  readonly rows: TaskRow[];
  /** Dense (rows × members) assigned-count grid (R12.3). */
  readonly assignedCounts: AssignedCountCell[];
  /** Dense (rows × members) Accepted→Complete average-duration grid (R12.4). */
  readonly avgAcceptedToComplete: AvgDurationCell[];
}

@Injectable({ providedIn: 'root' })
export class SupportStatisticsService {
  private readonly http = inject(HttpClient);
  private readonly apiConfig = inject(API_CONFIG);
  private readonly timezone = inject(TimezoneService);

  private get base(): string {
    return this.apiConfig.baseUrl;
  }

  /**
   * Fetch the Support Statistics datasets for the selected team (or all the
   * user's teams), with month buckets in the viewer's timezone
   * (`GET /api/stats/support?team=<sel>&tz=<IANA>`, R12, R18.3). The viewer's
   * effective timezone is always sent as `?tz`; the team selection travels as
   * `?team` ("all" or a numeric id).
   */
  getSupportStats(team: SupportStatsTeamSelection): Observable<SupportStatsResponse> {
    const params = new HttpParams()
      .set('team', team === 'all' ? 'all' : String(team))
      .set('tz', this.timezone.resolve());
    return this.http.get<SupportStatsResponse>(`${this.base}/stats/support`, { params });
  }
}
