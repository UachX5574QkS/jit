import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { PieChartComponent } from '../../shared/charts/pie-chart';
import { StackedBarChartComponent } from '../../shared/charts/stacked-bar-chart';
import { StatsNav } from './stats-nav';
import type { PieSlice, StackedBar } from '../../shared/charts/chart-data';
import { STATUSES, type Status } from '../support/status-transitions';
import type { TypeSummaryRow } from './user-statistics.service';
import {
  formatDurationSeconds,
  toStatusMonthBars,
  toTypeCountSlice,
  toTypeTimeSlice,
} from './user-statistics';
import {
  TeamStatisticsService,
  type TeamStatsResponse,
} from './team-statistics.service';

/**
 * The Team Statistics dashboard (design: "Statistics" — `GET /api/stats/team`;
 * R11, R19). Presents the SAME four views as User Statistics (task 13.1), but
 * scoped to the requests raised by everyone in the CURRENT USER's downward
 * management hierarchy (direct reports and, recursively, their reports, R11.1),
 * resolved server-side:
 *
 *   • a status-by-month STACKED BAR chart (R11 → R10.1), one bar per month,
 *     one segment per status;
 *   • a TYPE-COUNT PIE and, to its right, a TIME-BY-TYPE PIE (R10.2, R10.3);
 *   • a SUMMARY TABLE by task type (R10.4, R10.5) — request count, count per
 *     status, and the average New→Triage and Triage→Complete durations
 *     (Triage→Complete excludes Rejected/Cancelled, R11.2).
 *
 * ── Reuse of the User Statistics dashboard ──────────────────────────────────
 * Because the team endpoint returns the SAME payload shape as User Statistics,
 * this component reuses the exported view-model helpers ({@link toStatusMonthBars},
 * {@link toTypeCountSlice}, {@link toTypeTimeSlice}, {@link formatDurationSeconds})
 * and the shared chart wrappers, rather than duplicating that logic. Only the
 * data source (the team endpoint via {@link TeamStatisticsService}) and the
 * headings/empty-state copy differ.
 *
 * ── Presentation-only ────────────────────────────────────────────────────────
 * The backend does all aggregation, the hierarchy scoping (R19), and the
 * timezone month-bucketing (R18.3); this component maps the typed endpoint
 * payload into the chart wrappers' view models. The viewer's timezone travels
 * to the backend as `?tz` inside {@link TeamStatisticsService}.
 *
 * ── Empty state (R11.1) ──────────────────────────────────────────────────────
 * A leaf manager with NO reports gets empty datasets from the backend; the
 * screen renders an appropriate "no team activity" empty state instead of blank
 * charts.
 */
@Component({
  selector: 'app-team-statistics',
  standalone: true,
  imports: [StackedBarChartComponent, PieChartComponent, StatsNav],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './team-statistics.html',
  styleUrl: './user-statistics.scss',
})
export class TeamStatistics {
  private readonly service = inject(TeamStatisticsService);

  // ── Load state ──────────────────────────────────────────────────────────────

  protected readonly stats = signal<TeamStatsResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  /** True once a load has completed (drives the empty state). */
  protected readonly loaded = signal(false);

  /** The lifecycle statuses in canonical order, for the summary table columns (R10.4). */
  protected readonly statuses = STATUSES;

  // ── Chart view models (derived from the endpoint payload) ───────────────────

  /** Status-by-month bars for the shared stacked-bar wrapper (R11 → R10.1). */
  protected readonly monthBars = computed<StackedBar[]>(() =>
    toStatusMonthBars(this.stats()?.statusByMonth ?? []),
  );

  /** Type-count pie slices (R10.2). */
  protected readonly typeSlices = computed<PieSlice[]>(() =>
    (this.stats()?.typeCounts ?? []).map(toTypeCountSlice),
  );

  /** Time-by-type pie slices (R10.3). */
  protected readonly timeSlices = computed<PieSlice[]>(() =>
    (this.stats()?.timeByType ?? []).map(toTypeTimeSlice),
  );

  /** The summary rows for the table (R10.4, R10.5). */
  protected readonly summary = computed<readonly TypeSummaryRow[]>(
    () => this.stats()?.summary ?? [],
  );

  /** True when a completed, error-free load produced nothing to show (R11.1: leaf manager). */
  protected readonly isEmpty = computed(
    () =>
      this.loaded() &&
      !this.loading() &&
      !this.error() &&
      this.summary().length === 0 &&
      this.monthBars().length === 0,
  );

  constructor() {
    this.reload();
  }

  /** Fetch the statistics for the current user's downward hierarchy (R11). */
  protected reload(): void {
    this.loading.set(true);
    this.error.set(null);
    this.service.getTeamStats().subscribe({
      next: (stats) => {
        this.stats.set(stats);
        this.loading.set(false);
        this.loaded.set(true);
      },
      error: () => {
        this.stats.set(null);
        this.loading.set(false);
        this.loaded.set(true);
        this.error.set('Could not load your team statistics. Please try again.');
      },
    });
  }

  // ── Cell helpers ─────────────────────────────────────────────────────────────

  /** The count for a status within a summary row (0 when absent). */
  protected statusCount(row: TypeSummaryRow, status: Status): number {
    return row.countByStatus[status] ?? 0;
  }

  /** Human-formatted New→Triage average (R10.4); em-dash when none reached Triage. */
  protected newToTriageLabel(row: TypeSummaryRow): string {
    return formatDurationSeconds(row.avgNewToTriageSeconds);
  }

  /** Human-formatted Triage→Complete average (R10.4, R11.2); em-dash when none qualify. */
  protected triageToCompleteLabel(row: TypeSummaryRow): string {
    return formatDurationSeconds(row.avgTriageToCompleteSeconds);
  }

  /** Stable trackBy for the summary rows. */
  protected trackByTaskId(_index: number, row: TypeSummaryRow): number {
    return row.taskId;
  }
}
