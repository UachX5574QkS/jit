import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LocalDatePipe } from '../../shared/pipes/local-date.pipe';
import {
  RequestsListService,
  type RequestListRow,
  type RequestScope,
} from './requests-list.service';

/**
 * The user-side "Requests" screen — a searchable, filterable list of the
 * requests the current user raised or that fall under their management chain
 * (design: "Requests detail"/list; R4).
 *
 * ── Controls (R4.2–4.4) ──────────────────────────────────────────────────────
 *   • Search box (`q`)     — filters on any field within the active scope
 *     (R4.2). Debounced so keystrokes don't hammer the backend; a blank term
 *     means "no search".
 *   • My Requests / My Team toggle (`scope`) — defaults to "My Requests"
 *     (R4.3). "My Requests" shows requests the user raised; "My Team" shows
 *     requests raised by anyone in the user's downward management hierarchy,
 *     scoped server-side (R4.3, R19).
 *   • Hide Complete checkbox (`hideComplete`) — defaults to CHECKED; when
 *     checked, COMPLETE / REJECTED / CANCELLED requests are excluded (R4.4).
 *
 * Any control change re-queries `GET /api/requests` with the current scope,
 * hide-complete flag, and search term (R4.9 — server owns filtering/scoping).
 *
 * ── Columns (R4.5–4.8) ───────────────────────────────────────────────────────
 * Each row shows Task Number, Jira Number, Title, Date Raised, Status, Support
 * Team, Assigned Team Member, Last Updated, Estimated Start Date, Actual Start
 * Date, Estimated Effort, and an "Updated" indicator (R4.5). The displayed
 * status gains a " (Working On)" suffix when the request has an open timer and
 * is not closed (R4.6). The "Updated" pill shows when the request changed since
 * the viewer last opened it (R4.8). All timestamps render in the viewer's
 * browser-local time via {@link LocalDatePipe} (R4.9, R18.2).
 *
 * ── Row navigation ───────────────────────────────────────────────────────────
 * Each row links to the request detail view at `/requests/:id` (task 11.2) —
 * the same destination the New workflow navigates to on submit.
 */

/** The stop (closed) statuses excluded by Hide Complete and used for the timer suffix (R4.4, R4.6, R9.3). */
const STOP_STATUSES: ReadonlySet<string> = new Set(['COMPLETE', 'REJECTED', 'CANCELLED']);

/** How long to wait after the last keystroke before re-querying (ms). */
const SEARCH_DEBOUNCE_MS = 300;

@Component({
  selector: 'app-requests-list',
  standalone: true,
  imports: [RouterLink, LocalDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './requests-list.html',
  styleUrl: './requests-list.scss',
})
export class RequestsList {
  private readonly service = inject(RequestsListService);
  private readonly router = inject(Router);

  // ── Filter state (R4.2–4.4) ────────────────────────────────────────────────

  /** The active scope toggle; defaults to "mine" / My Requests (R4.3). */
  protected readonly scope = signal<RequestScope>('mine');
  /** Hide Complete; defaults to CHECKED / true (R4.4). */
  protected readonly hideComplete = signal(true);
  /** The current (already-trimmed-on-query) search term (R4.2). */
  protected readonly search = signal('');

  // ── List state ──────────────────────────────────────────────────────────────

  protected readonly rows = signal<readonly RequestListRow[]>([]);
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

  // ── Control handlers (each re-queries the backend, R4.9) ────────────────────

  /** Switch the My Requests / My Team toggle and reload (R4.3). */
  protected setScope(scope: RequestScope): void {
    if (this.scope() === scope) {
      return;
    }
    this.scope.set(scope);
    this.reload();
  }

  /** Toggle Hide Complete and reload (R4.4). */
  protected toggleHideComplete(): void {
    this.hideComplete.update((v) => !v);
    this.reload();
  }

  /**
   * Handle a keystroke in the search box (R4.2). The term is stored immediately
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

  /** Fetch the list for the current scope / hide-complete / search (R4.9). */
  protected reload(): void {
    this.loading.set(true);
    this.error.set(null);
    const term = this.search().trim();
    this.service
      .list({
        scope: this.scope(),
        hideComplete: this.hideComplete(),
        search: term === '' ? null : term,
      })
      .subscribe({
        next: (rows) => {
          this.rows.set(rows);
          this.loading.set(false);
          this.loaded.set(true);
        },
        error: () => {
          this.rows.set([]);
          this.loading.set(false);
          this.loaded.set(true);
          this.error.set('Could not load your requests. Please try again.');
        },
      });
  }

  // ── Row helpers ─────────────────────────────────────────────────────────────

  /**
   * The status to display for a row: the raw status, with " (Working On)"
   * appended when a support member has an open timer against it AND the request
   * is not in a closed state (R4.6).
   */
  protected displayStatus(row: RequestListRow): string {
    if (row.hasOpenTimer && !STOP_STATUSES.has(row.status)) {
      return `${row.status} (Working On)`;
    }
    return row.status;
  }

  /** True when the row's status is a closed/stop state (drives status styling). */
  protected isClosed(row: RequestListRow): boolean {
    return STOP_STATUSES.has(row.status);
  }

  /**
   * The Estimated Effort cell text (R4.7). `null` (no complete requests of the
   * type yet) renders as an em-dash; otherwise a human "Xd Yh Zm" duration
   * rounded to whole minutes.
   */
  protected effortLabel(row: RequestListRow): string {
    return formatMinutes(row.estimatedEffortMinutes);
  }

  /** Navigate to the request detail view at `/requests/:id` (task 11.2). */
  protected openRequest(row: RequestListRow): void {
    void this.router.navigate(['/requests', row.id]);
  }

  /** Stable trackBy for the row loop. */
  protected trackById(_index: number, row: RequestListRow): number {
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
