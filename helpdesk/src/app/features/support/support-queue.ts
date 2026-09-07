import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { CurrentUserService } from '../../core/auth/current-user.service';
import { LocalDatePipe } from '../../shared/pipes/local-date.pipe';
import {
  SupportQueueService,
  type SupportQueueRow,
  type SupportScope,
  type SupportTeamSelection,
} from './support-queue.service';

/**
 * The "Support" screen — a searchable, filterable view of a support member's
 * request queue (design: "Support detail"/queue; R6).
 *
 * ── Controls (R6.2–6.6) ──────────────────────────────────────────────────────
 *   • Team drop-down (`team`)     — "All Teams" plus one entry per team the
 *     current user belongs to (R6.3). Scoping the drop-down to the user's own
 *     teams matches the server, which membership-checks any explicit team and
 *     only ever exposes the caller's own teams' queues.
 *   • My Queue / Team Queue toggle (`scope`) — defaults to "My Queue" (R6.4).
 *     "My Queue" shows requests assigned to the current user; "Team Queue"
 *     shows requests for the selected team (or all the user's teams when
 *     "All Teams" is selected).
 *   • Hide Complete checkbox (`hideComplete`) — defaults to CHECKED; when
 *     checked, COMPLETE / CANCELLED / REJECTED requests are excluded (R6.5).
 *   • Show Unassigned checkbox (`showUnassigned`) — defaults to CHECKED; when
 *     checked, requests with no assigned member are included (R6.6).
 *   • Search box (`q`) — filters on any field within the active scope + team
 *     drop-down (R6.2). Debounced; a blank term means "no search".
 *
 * Any control change re-queries `GET /api/support/requests` with the current
 * team, scope, hide-complete, show-unassigned, and search term (R6 — the server
 * owns filtering/scoping).
 *
 * ── Columns (R6.7) ───────────────────────────────────────────────────────────
 * Each row shows the SAME columns as the Requests screen: Task Number, Jira
 * Number, Title, Date Raised, Status, Support Team, Assigned Team Member, Last
 * Updated, Estimated Start Date, Actual Start Date, Estimated Effort, and an
 * "Updated" indicator. The status gains a " (Working On)" suffix when the
 * request has an open timer and is not closed (R4.6). All timestamps render in
 * the viewer's browser-local time via {@link LocalDatePipe} (R18.2).
 *
 * ── Team drop-down labels ────────────────────────────────────────────────────
 * The resolved `CurrentUser` carries the ids of the teams the user belongs to
 * (`teamsMemberOf`) but not their titles. The queue rows do carry `teamTitle`,
 * so as rows arrive their id→title mappings are cached and used to label the
 * drop-down. A team the user is in but that has no visible request yet falls
 * back to "Team #<id>" until one of its requests surfaces its title.
 *
 * ── Row navigation ───────────────────────────────────────────────────────────
 * Each row links to the support detail view at `/support/:id` (task 12.2).
 */

/** The stop (closed) statuses excluded by Hide Complete and used for the timer suffix (R6.5, R4.6, R9.3). */
const STOP_STATUSES: ReadonlySet<string> = new Set(['COMPLETE', 'REJECTED', 'CANCELLED']);

/** How long to wait after the last keystroke before re-querying (ms). */
const SEARCH_DEBOUNCE_MS = 300;

/** One option in the "Team" drop-down: "All Teams" or a specific team (R6.3). */
export interface TeamOption {
  /** The selection value: "all" or a numeric team id. */
  readonly value: SupportTeamSelection;
  /** The label shown in the drop-down. */
  readonly label: string;
}

@Component({
  selector: 'app-support-queue',
  standalone: true,
  imports: [RouterLink, LocalDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './support-queue.html',
  styleUrl: './support-queue.scss',
})
export class SupportQueue {
  private readonly service = inject(SupportQueueService);
  private readonly router = inject(Router);
  private readonly currentUser = inject(CurrentUserService);

  // ── Filter state (R6.2–6.6) ────────────────────────────────────────────────

  /** The selected team; defaults to "all" / All Teams (R6.3). */
  protected readonly team = signal<SupportTeamSelection>('all');
  /** The active scope toggle; defaults to "mine" / My Queue (R6.4). */
  protected readonly scope = signal<SupportScope>('mine');
  /** Hide Complete; defaults to CHECKED / true (R6.5). */
  protected readonly hideComplete = signal(true);
  /** Show Unassigned; defaults to CHECKED / true (R6.6). */
  protected readonly showUnassigned = signal(true);
  /** The current (already-trimmed-on-query) search term (R6.2). */
  protected readonly search = signal('');

  // ── Team drop-down (R6.3) ───────────────────────────────────────────────────

  /** The ids of the teams the current user belongs to (drives the drop-down). */
  private readonly teamIds = signal<readonly number[]>(
    this.currentUser.snapshot()?.teamsMemberOf ?? [],
  );

  /** Cache of team id → title, populated from rows as they arrive. */
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

  // ── List state ──────────────────────────────────────────────────────────────

  protected readonly rows = signal<readonly SupportQueueRow[]>([]);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  /** True once at least one load has completed (drives the empty state). */
  protected readonly loaded = signal(false);

  /** True when there are no rows to show after a completed, error-free load. */
  protected readonly isEmpty = computed(
    () => this.loaded() && !this.loading() && !this.error() && this.rows().length === 0,
  );

  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.reload();
  }

  // ── Control handlers (each re-queries the backend, R6) ──────────────────────

  /**
   * Switch the selected team from the drop-down and reload (R6.3). The raw
   * value is "all" or a numeric-id string; anything else is ignored defensively.
   */
  protected onTeamChange(value: string): void {
    const next: SupportTeamSelection = value === 'all' ? 'all' : Number(value);
    if (next !== 'all' && !Number.isSafeInteger(next)) {
      return;
    }
    if (this.team() === next) {
      return;
    }
    this.team.set(next);
    this.reload();
  }

  /** Switch the My Queue / Team Queue toggle and reload (R6.4). */
  protected setScope(scope: SupportScope): void {
    if (this.scope() === scope) {
      return;
    }
    this.scope.set(scope);
    this.reload();
  }

  /** Toggle Hide Complete and reload (R6.5). */
  protected toggleHideComplete(): void {
    this.hideComplete.update((v) => !v);
    this.reload();
  }

  /** Toggle Show Unassigned and reload (R6.6). */
  protected toggleShowUnassigned(): void {
    this.showUnassigned.update((v) => !v);
    this.reload();
  }

  /**
   * Handle a keystroke in the search box (R6.2). The term is stored immediately
   * so the input stays controlled, but the backend query is debounced so a
   * burst of keystrokes triggers a single reload.
   */
  protected onSearchInput(value: string): void {
    this.search.set(value);
    if (this.searchTimer !== null) {
      clearTimeout(this.searchTimer);
    }
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      this.reload();
    }, SEARCH_DEBOUNCE_MS);
  }

  /** Fetch the queue for the current team / scope / filters / search (R6). */
  protected reload(): void {
    this.loading.set(true);
    this.error.set(null);
    const term = this.search().trim();
    this.service
      .list({
        team: this.team(),
        scope: this.scope(),
        hideComplete: this.hideComplete(),
        showUnassigned: this.showUnassigned(),
        search: term === '' ? null : term,
      })
      .subscribe({
        next: (rows) => {
          this.rows.set(rows);
          this.cacheTeamLabels(rows);
          this.loading.set(false);
          this.loaded.set(true);
        },
        error: () => {
          this.rows.set([]);
          this.loading.set(false);
          this.loaded.set(true);
          this.error.set('Could not load the support queue. Please try again.');
        },
      });
  }

  /** Merge each row's team id→title into the drop-down label cache (R6.3). */
  private cacheTeamLabels(rows: readonly SupportQueueRow[]): void {
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

  // ── Row helpers ─────────────────────────────────────────────────────────────

  /**
   * The status to display for a row: the raw status, with " (Working On)"
   * appended when a support member has an open timer against it AND the request
   * is not in a closed state (R4.6).
   */
  protected displayStatus(row: SupportQueueRow): string {
    if (row.hasOpenTimer && !STOP_STATUSES.has(row.status)) {
      return `${row.status} (Working On)`;
    }
    return row.status;
  }

  /** True when the row's status is a closed/stop state (drives status styling). */
  protected isClosed(row: SupportQueueRow): boolean {
    return STOP_STATUSES.has(row.status);
  }

  /**
   * The Estimated Effort cell text (R4.7). `null` (no complete requests of the
   * type yet) renders as an em-dash; otherwise a human "Xd Yh Zm" duration
   * rounded to whole minutes.
   */
  protected effortLabel(row: SupportQueueRow): string {
    return formatMinutes(row.estimatedEffortMinutes);
  }

  /** Navigate to the support detail view at `/support/:id` (task 12.2). */
  protected openRequest(row: SupportQueueRow): void {
    void this.router.navigate(['/support', row.id]);
  }

  /** Stable trackBy for the row loop. */
  protected trackById(_index: number, row: SupportQueueRow): number {
    return row.id;
  }
}

/**
 * Format a whole-minute duration as "Xd Yh Zm", omitting leading zero units,
 * or an em-dash for `null`/negative (R4.7). Exported for direct unit testing.
 *   • null  → "—"
 *   • 0     → "0m"
 *   • 90    → "1h 30m"
 *   • 1500  → "1d 1h"
 */
export function formatMinutes(minutes: number | null): string {
  if (minutes === null || minutes < 0) {
    return '—';
  }
  const whole = Math.round(minutes);
  if (whole === 0) {
    return '0m';
  }
  const days = Math.floor(whole / (60 * 24));
  const hours = Math.floor((whole % (60 * 24)) / 60);
  const mins = whole % 60;
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
