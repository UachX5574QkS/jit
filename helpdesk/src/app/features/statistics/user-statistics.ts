import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { PieChartComponent } from '../../shared/charts/pie-chart';
import { StackedBarChartComponent } from '../../shared/charts/stacked-bar-chart';
import { StatsNav } from './stats-nav';
import type { PieSlice, StackedBar } from '../../shared/charts/chart-data';
import { STATUSES, type Status } from '../support/status-transitions';
import {
  UserStatisticsService,
  type StatusMonthBucket,
  type TypeCountSlice,
  type TypeSummaryRow,
  type TypeTimeSlice,
  type UserStatsResponse,
} from './user-statistics.service';

/**
 * The User Statistics dashboard (design: "Statistics"; R10). Presents four
 * views of the requests the CURRENT USER has raised, all computed server-side
 * and rendered here in the ui-foundations style (content cards, bar-row charts,
 * pie charts, summary table):
 *
 *   • a status-by-month STACKED BAR chart (R10.1), using the shared stacked-bar
 *     wrapper — one bar per month, one segment per status;
 *   • a TYPE-COUNT PIE and, to its right, a TIME-BY-TYPE PIE (R10.2, R10.3),
 *     using the shared pie wrapper — request counts and recorded time by task
 *     type as proportions of the whole;
 *   • a SUMMARY TABLE by task type (R10.4, R10.5) — request count, count per
 *     status, and the average New→Triage and Triage→Complete durations
 *     (Triage→Complete excludes Rejected/Cancelled, computed by the backend).
 *
 * ── Presentation-only ────────────────────────────────────────────────────────
 * The backend does all aggregation and the timezone month-bucketing (R18.3);
 * this component maps the typed endpoint payload into the chart wrappers' view
 * models and formats the summary durations as human strings. The viewer's
 * timezone travels to the backend as `?tz` inside {@link UserStatisticsService}
 * (via the shared TimezoneService), so the buckets match the dates rendered
 * elsewhere on screen.
 */
@Component({
  selector: 'app-user-statistics',
  standalone: true,
  imports: [StackedBarChartComponent, PieChartComponent, StatsNav],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './user-statistics.html',
  styleUrl: './user-statistics.scss',
})
export class UserStatistics {
  private readonly service = inject(UserStatisticsService);

  // ── Load state ──────────────────────────────────────────────────────────────

  protected readonly stats = signal<UserStatsResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  /** True once a load has completed (drives the empty state). */
  protected readonly loaded = signal(false);

  /** The lifecycle statuses in canonical order, for the summary table columns (R10.4). */
  protected readonly statuses = STATUSES;

  // ── Chart view models (derived from the endpoint payload) ───────────────────

  /** Status-by-month bars for the shared stacked-bar wrapper (R10.1). */
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

  /** True when a completed, error-free load produced nothing to show. */
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

  /** Fetch the statistics for the current user (R10). */
  protected reload(): void {
    this.loading.set(true);
    this.error.set(null);
    this.service.getUserStats().subscribe({
      next: (stats) => {
        this.stats.set(stats);
        this.loading.set(false);
        this.loaded.set(true);
      },
      error: () => {
        this.stats.set(null);
        this.loading.set(false);
        this.loaded.set(true);
        this.error.set('Could not load your statistics. Please try again.');
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

  /** Human-formatted Triage→Complete average (R10.4, R10.5); em-dash when none qualify. */
  protected triageToCompleteLabel(row: TypeSummaryRow): string {
    return formatDurationSeconds(row.avgTriageToCompleteSeconds);
  }

  /** Stable trackBy for the summary rows. */
  protected trackByTaskId(_index: number, row: TypeSummaryRow): number {
    return row.taskId;
  }
}

/**
 * Map the flat (month, status, count) buckets into the {@link StackedBar} shape
 * the shared wrapper expects: one bar per month (chronological), each holding
 * one segment per status IN CANONICAL LIFECYCLE ORDER (R10.1). Only statuses
 * that occur in a month become segments, so empty statuses don't clutter the
 * bar; the wrapper assigns colours by segment index and derives the legend from
 * what it draws. Exported for direct unit testing.
 */
export function toStatusMonthBars(buckets: readonly StatusMonthBucket[]): StackedBar[] {
  // Group counts by month, then by status.
  const byMonth = new Map<string, Map<Status, number>>();
  for (const b of buckets) {
    let statuses = byMonth.get(b.month);
    if (!statuses) {
      statuses = new Map<Status, number>();
      byMonth.set(b.month, statuses);
    }
    statuses.set(b.status, (statuses.get(b.status) ?? 0) + b.count);
  }

  // Months in chronological order (YYYY-MM sorts lexically = chronologically).
  const months = [...byMonth.keys()].sort();
  return months.map((month) => {
    const statuses = byMonth.get(month)!;
    // Emit segments in canonical status order so colours are consistent across bars.
    const segments = STATUSES.filter((s) => (statuses.get(s) ?? 0) > 0).map((s) => ({
      label: s,
      value: statuses.get(s)!,
    }));
    return { label: month, segments };
  });
}

/** Map a type-count row into a pie slice (R10.2). */
export function toTypeCountSlice(slice: TypeCountSlice): PieSlice {
  return { label: slice.taskName, value: slice.count };
}

/** Map a time-by-type row into a pie slice using its recorded minutes (R10.3). */
export function toTypeTimeSlice(slice: TypeTimeSlice): PieSlice {
  return { label: slice.taskName, value: slice.totalMinutes };
}

/**
 * Format an average duration expressed in SECONDS as a human "Xd Yh Zm" string,
 * omitting leading zero units (R10.4). `null` (no qualifying requests) renders
 * as an em-dash. A sub-minute but positive duration shows as "<1m" so a tiny
 * average is not misleadingly rounded to "0m". Exported for direct unit testing.
 *   • null   → "—"
 *   • 0      → "0m"
 *   • 30     → "<1m"
 *   • 5400   → "1h 30m"
 *   • 90000  → "1d 1h"
 */
export function formatDurationSeconds(seconds: number | null): string {
  if (seconds === null || seconds < 0) {
    return '—';
  }
  if (seconds === 0) {
    return '0m';
  }
  const totalMinutes = Math.floor(seconds / 60);
  if (totalMinutes === 0) {
    return '<1m';
  }
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const mins = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (mins > 0) {
    parts.push(`${mins}m`);
  }
  return parts.join(' ');
}
