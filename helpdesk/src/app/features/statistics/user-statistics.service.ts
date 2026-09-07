import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { API_CONFIG } from '../../core/http/api-config';
import { TimezoneService } from '../../core/timezone/timezone.service';
import type { Status } from '../support/status-transitions';

/**
 * Typed client for the User Statistics contract (design: "Statistics" —
 * `GET /api/stats/user`; R10, R18.3). Feature code talks to this service, never
 * to `HttpClient` directly, so the REST contract is the only coupling to the
 * backend (design: "Data access"). The single method maps the one documented
 * endpoint:
 *
 *   • {@link getUserStats}  GET /api/stats/user?tz=<IANA>   (R10, R18.3)
 *
 * ── Timezone (R10.1, R18.3) ──────────────────────────────────────────────────
 * The "by month" buckets are computed server-side in the viewer's timezone. The
 * client passes its effective timezone as `?tz=<IANA>` via the shared
 * {@link TimezoneService} (browser zone first, then the user's stored zone, then
 * UTC), so the backend's `AT TIME ZONE` bucketing matches what the local-date
 * pipe renders on the same screen.
 *
 * The backend already aggregates everything the dashboard needs — the
 * status-by-month buckets (R10.1), the type-count and time-by-type pie slices
 * (R10.2, R10.3), and the per-task-type summary rows with the New→Triage and
 * Triage→Complete averages (R10.4, R10.5) — so the screen renders purely from
 * typed data.
 */

/** One (month, status, count) bucket of the status-by-month stacked bar (R10.1). */
export interface StatusMonthBucket {
  /** The month the request's created_at falls into in the viewer's timezone, `YYYY-MM`. */
  readonly month: string;
  readonly status: Status;
  readonly count: number;
}

/** One slice of the type-count pie (R10.2). */
export interface TypeCountSlice {
  readonly taskId: number;
  readonly taskName: string;
  readonly count: number;
}

/** One slice of the time-by-type pie (R10.3). */
export interface TypeTimeSlice {
  readonly taskId: number;
  readonly taskName: string;
  /** Total recorded time-slice minutes across the user's requests of this type. */
  readonly totalMinutes: number;
}

/** One row of the summary table (R10.4, R10.5). */
export interface TypeSummaryRow {
  readonly taskId: number;
  readonly taskName: string;
  readonly requestCount: number;
  /** Count of the user's requests of this type per status; every status present. */
  readonly countByStatus: Readonly<Record<Status, number>>;
  /** Average time from New to first Triage, in seconds, or null when none reached Triage. */
  readonly avgNewToTriageSeconds: number | null;
  /**
   * Average lifespan from first Triage to Complete, in seconds, excluding
   * Rejected/Cancelled (R10.5), or null when none qualify.
   */
  readonly avgTriageToCompleteSeconds: number | null;
}

/** The full User Statistics payload returned by `GET /api/stats/user`. */
export interface UserStatsResponse {
  /** The IANA timezone the month buckets were computed in (echoed by the backend). */
  readonly timezone: string;
  readonly statusByMonth: StatusMonthBucket[];
  readonly typeCounts: TypeCountSlice[];
  readonly timeByType: TypeTimeSlice[];
  readonly summary: TypeSummaryRow[];
}

@Injectable({ providedIn: 'root' })
export class UserStatisticsService {
  private readonly http = inject(HttpClient);
  private readonly apiConfig = inject(API_CONFIG);
  private readonly timezone = inject(TimezoneService);

  private get base(): string {
    return this.apiConfig.baseUrl;
  }

  /**
   * Fetch the User Statistics datasets for the current user
   * (`GET /api/stats/user?tz=<IANA>`, R10, R18.3). The viewer's effective
   * timezone is always sent as `?tz` so the month buckets align with the dates
   * rendered on the same screen.
   */
  getUserStats(): Observable<UserStatsResponse> {
    const params = new HttpParams().set('tz', this.timezone.resolve());
    return this.http.get<UserStatsResponse>(`${this.base}/stats/user`, { params });
  }
}
