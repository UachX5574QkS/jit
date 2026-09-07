import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { StackedBarChartComponent } from '../../shared/charts/stacked-bar-chart';
import { StatsNav } from './stats-nav';
import type { StackedBar } from '../../shared/charts/chart-data';
import { CurrentUserService } from '../../core/auth/current-user.service';
import { formatDurationSeconds, toStatusMonthBars } from './user-statistics';
import {
  SupportStatisticsService,
  type AssignedCountCell,
  type AvgDurationCell,
  type MemberColumn,
  type SupportStatsResponse,
  type SupportStatsTeamSelection,
  type TaskRow,
} from './support-statistics.service';

/**
 * The Support Statistics dashboard (design: "Statistics" —
 * `GET /api/stats/support?team=|all`; R12). A SUPPORT-side view scoped to a
 * support team (or every team the current user belongs to), reachable at
 * `/statistics/support` — support-members-only via the shared stats-nav tab
 * (R12.1) and the route's support guard. It presents four things, all computed
 * server-side and rendered here in the ui-foundations style:
 *
 *   • a TEAM DROP-DOWN with an "All Teams" option covering every team the user
 *     is in simultaneously (R12.1); changing it re-queries with `?team`;
 *   • a status-by-month STACKED BAR chart (R12.2 → R18.3), reusing the shared
 *     wrapper and the {@link toStatusMonthBars} view-model helper from the User
 *     Statistics dashboard (task 13.1);
 *   • the ASSIGNED-COUNT table (R12.3): rows are task types (or "Team - Task"
 *     across teams) and columns are the team members; each cell is the number
 *     of requests of that type assigned to that member, regardless of status;
 *   • the ACCEPTED→COMPLETE average-duration table (R12.4): the same rows ×
 *     members, each cell the human-formatted average duration (em-dash when
 *     null — no qualifying request, or all Rejected/Cancelled).
 *
 * ── Presentation-only ────────────────────────────────────────────────────────
 * The backend does all aggregation, the team-membership scoping (R12.1), the
 * timezone month-bucketing (R12.2 → R18.3), and — crucially — DENSIFIES both
 * grids across the full (rows × members) cross-product and provides each row's
 * `label`. This component therefore maps the typed payload straight into the
 * chart wrapper and looks cells up by (taskId, memberId) to fill the matrix.
 * The viewer's timezone travels to the backend as `?tz` inside
 * {@link SupportStatisticsService}.
 *
 * ── Team drop-down (R12.1) ───────────────────────────────────────────────────
 * The resolved {@link CurrentUser} carries the ids of the teams the user belongs
 * to (`teamsMemberOf`) but not their titles; the response `rows` carry
 * `teamId` + `teamTitle`, so those id→title mappings are cached as responses
 * arrive and used to label the drop-down (falling back to "Team #<id>" until a
 * title surfaces). "All Teams" is always the first option.
 *
 * ── Empty state (R12.1) ──────────────────────────────────────────────────────
 * A user in no teams (or a scope with no task rows) gets empty datasets; the
 * screen renders an appropriate empty state instead of blank charts and tables.
 */
@Component({
  selector: 'app-support-statistics',
  standalone: true,
  imports: [StackedBarChartComponent, StatsNav],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './support-statistics.html',
  styleUrl: './support-statistics.scss',
})
export class SupportStatistics {
  private readonly service = inject(SupportStatisticsService);
  private readonly currentUser = inject(CurrentUserService);

  // ── Team selector (R12.1) ───────────────────────────────────────────────────

  /** The selected team; defaults to "all" / All Teams (R12.1). */
  protected readonly team = signal<SupportStatsTeamSelection>('all');

  /** The ids of the teams the current user belongs to (drives the drop-down). */
  private readonly teamIds = signal<readonly number[]>(
    this.currentUser.snapshot()?.teamsMemberOf ?? [],
  );

  /** Cache of team id → title, populated from response rows as they arrive. */
  private readonly teamLabels = signal<ReadonlyMap<number, string>>(new Map());

  /**
   * The "Team" drop-down options: "All Teams" plus one entry per team the user
   * belongs to, labelled from {@link teamLabels} (falling back to "Team #<id>").
   */
  protected readonly teamOptions = computed<readonly TeamOption[]>(() => {
    const labels = this.teamLabels();
    const opts: TeamOption[] = [{ value: 'all', label: 'All Teams' }];
    for (const id of this.teamIds()) {
      opts.push({ value: id, label: labels.get(id) ?? `Team #${id}` });
    }
    return opts;
  });

  /** The current team selection as the drop-down's string value ("all" or id). */
  protected readonly teamValue = computed<string>(() => {
    const t = this.team();
    return t === 'all' ? 'all' : String(t);
  });

  // ── Load state ──────────────────────────────────────────────────────────────

  protected readonly stats = signal<SupportStatsResponse | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  /** True once a load has completed (drives the empty state). */
  protected readonly loaded = signal(false);

  // ── Chart + table view models (derived from the endpoint payload) ───────────

  /** Status-by-month bars for the shared stacked-bar wrapper (R12.2 → R10.1). */
  protected readonly monthBars = computed<StackedBar[]>(() =>
    toStatusMonthBars(this.stats()?.statusByMonth ?? []),
  );

  /** The shared table COLUMNS — team members in scope (R12.3/R12.4). */
  protected readonly members = computed<readonly MemberColumn[]>(
    () => this.stats()?.members ?? [],
  );

  /** The shared table ROWS — task types in scope, with render `label` (R12.3/R12.4). */
  protected readonly rows = computed<readonly TaskRow[]>(() => this.stats()?.rows ?? []);

  /**
   * The dense assigned-count grid keyed `taskId:memberId` → count (R12.3). The
   * backend already densifies, so every (row × member) pair is present; the map
   * makes cell lookup O(1) from the template.
   */
  private readonly assignedByKey = computed<ReadonlyMap<string, number>>(() => {
    const map = new Map<string, number>();
    for (const c of this.stats()?.assignedCounts ?? []) {
      map.set(cellKey(c.taskId, c.memberId), c.count);
    }
    return map;
  });

  /**
   * The dense Accepted→Complete grid keyed `taskId:memberId` → average seconds
   * or null (R12.4).
   */
  private readonly avgByKey = computed<ReadonlyMap<string, number | null>>(() => {
    const map = new Map<string, number | null>();
    for (const c of this.stats()?.avgAcceptedToComplete ?? []) {
      map.set(cellKey(c.taskId, c.memberId), c.avgAcceptedToCompleteSeconds);
    }
    return map;
  });

  /** True when a completed, error-free load produced nothing to show (R12.1). */
  protected readonly isEmpty = computed(
    () =>
      this.loaded() &&
      !this.loading() &&
      !this.error() &&
      this.rows().length === 0 &&
      this.monthBars().length === 0,
  );

  constructor() {
    this.reload();
  }

  // ── Control handler (re-queries the backend, R12.1) ─────────────────────────

  /**
   * Switch the selected team from the drop-down and reload (R12.1). The raw
   * value is "all" or a numeric-id string; anything else is ignored defensively.
   */
  protected onTeamChange(value: string): void {
    const next: SupportStatsTeamSelection = value === 'all' ? 'all' : Number(value);
    if (next !== 'all' && !Number.isSafeInteger(next)) {
      return;
    }
    if (this.team() === next) {
      return;
    }
    this.team.set(next);
    this.reload();
  }

  /** Fetch the statistics for the selected team scope (R12). */
  protected reload(): void {
    this.loading.set(true);
    this.error.set(null);
    this.service.getSupportStats(this.team()).subscribe({
      next: (stats) => {
        this.stats.set(stats);
        this.cacheTeamLabels(stats.rows);
        this.loading.set(false);
        this.loaded.set(true);
      },
      error: () => {
        this.stats.set(null);
        this.loading.set(false);
        this.loaded.set(true);
        this.error.set('Could not load the support statistics. Please try again.');
      },
    });
  }

  /** Merge each row's team id→title into the drop-down label cache (R12.1). */
  private cacheTeamLabels(rows: readonly TaskRow[]): void {
    if (rows.length === 0) {
      return;
    }
    let changed = false;
    const next = new Map(this.teamLabels());
    for (const r of rows) {
      if (next.get(r.teamId) !== r.teamTitle) {
        next.set(r.teamId, r.teamTitle);
        changed = true;
      }
    }
    if (changed) {
      this.teamLabels.set(next);
    }
  }

  // ── Cell helpers ─────────────────────────────────────────────────────────────

  /** The assigned-request count for a (row, member) cell (0 when absent, R12.3). */
  protected assignedCount(row: TaskRow, member: MemberColumn): number {
    return this.assignedByKey().get(cellKey(row.taskId, member.memberId)) ?? 0;
  }

  /**
   * The human-formatted Accepted→Complete average for a (row, member) cell
   * (R12.4); an em-dash when the cell is null (no qualifying request, or all
   * were Rejected/Cancelled).
   */
  protected avgDurationLabel(row: TaskRow, member: MemberColumn): string {
    const seconds = this.avgByKey().get(cellKey(row.taskId, member.memberId)) ?? null;
    return formatDurationSeconds(seconds);
  }

  /** Stable trackBy for the row loop (task-type rows). */
  protected trackByTaskId(_index: number, row: TaskRow): number {
    return row.taskId;
  }

  /** Stable trackBy for the member-column loop. */
  protected trackByMemberId(_index: number, member: MemberColumn): number {
    return member.memberId;
  }
}

/** One option in the "Team" drop-down: "All Teams" or a specific team (R12.1). */
export interface TeamOption {
  /** The selection value: "all" or a numeric team id. */
  readonly value: SupportStatsTeamSelection;
  /** The label shown in the drop-down. */
  readonly label: string;
}

/** The composite key for a dense-grid cell — mirrors the backend's densifier. */
function cellKey(taskId: number, memberId: number): string {
  return `${taskId}:${memberId}`;
}

// Re-export the grid cell types so tests and callers can reference them via the
// component module alongside the view models.
export type { AssignedCountCell, AvgDurationCell };
