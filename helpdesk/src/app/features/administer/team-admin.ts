import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { ApiError } from '../../core/http/api-error';
import { LocalDatePipe } from '../../shared/pipes/local-date.pipe';
import {
  TeamAdminService,
  type AdminUserView,
  type TeamView,
} from './team-admin.service';

/**
 * The Tool-Administrator Teams management screen (task 14.1; design:
 * "Administer — admin tiles"; R13, R20.2).
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 * An administrator can:
 *   • LIST every team in a table — title, leader, and open/closed state (R13.3);
 *   • CREATE a team (title, optional description, leader) (R13.2);
 *   • CHANGE a team's leader/owner via an inline leader drop-down (R13.3);
 *   • CLOSE a team (R13.3), which the backend refuses while the team still has
 *     any non-closed request — that `CONFLICT_OPEN_REQUESTS` is surfaced
 *     GRACEFULLY as a row-level message rather than an error banner (R20.2).
 *
 * ── AuthZ is server-side ─────────────────────────────────────────────────────
 * The route is admin-guarded for UX, and every endpoint is enforced server-side
 * (R13.1). If a `FORBIDDEN` still comes back it is shown as a friendly message
 * rather than a crash.
 *
 * ── Presentation-only ────────────────────────────────────────────────────────
 * All data comes from {@link TeamAdminService}; the leader drop-down is built
 * from `GET /api/admin/users`. Leader ids are resolved to display names via a
 * lookup map so the table shows names, not numbers.
 */
@Component({
  selector: 'app-team-admin',
  standalone: true,
  imports: [FormsModule, RouterLink, LocalDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './team-admin.html',
  styleUrl: './team-admin.scss',
})
export class TeamAdmin {
  private readonly service = inject(TeamAdminService);

  // ── Data ──────────────────────────────────────────────────────────────────
  protected readonly teams = signal<TeamView[]>([]);
  protected readonly users = signal<AdminUserView[]>([]);
  protected readonly loading = signal(false);
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Per-team row message (e.g. the close-blocked conflict), keyed by team id. */
  protected readonly rowMessages = signal<Readonly<Record<number, string>>>({});

  /** userId → display name, for rendering the leader column (R13.3). */
  protected readonly userNames = computed<ReadonlyMap<number, string>>(() => {
    const map = new Map<number, string>();
    for (const u of this.users()) {
      map.set(u.id, u.displayName);
    }
    return map;
  });

  protected readonly isEmpty = computed(
    () => this.loaded() && !this.loading() && !this.error() && this.teams().length === 0,
  );

  // ── Create-team form ────────────────────────────────────────────────────────
  protected readonly newTitle = signal('');
  protected readonly newDescription = signal('');
  protected readonly newLeaderId = signal<number | null>(null);
  protected readonly creating = signal(false);
  protected readonly createError = signal<string | null>(null);

  /** True when the create form has the minimum required fields (R13.2). */
  protected readonly canCreate = computed(
    () => this.newTitle().trim() !== '' && this.newLeaderId() !== null && !this.creating(),
  );

  constructor() {
    this.reload();
  }

  /** Load the teams table and the leader-picker people (R13.2, R13.3). */
  protected reload(): void {
    this.loading.set(true);
    this.error.set(null);
    forkJoin({
      teams: this.service.listTeams(),
      users: this.service.listUsers(),
    }).subscribe({
      next: ({ teams, users }) => {
        this.teams.set(teams);
        this.users.set(users);
        this.loading.set(false);
        this.loaded.set(true);
      },
      error: (err: unknown) => {
        this.loading.set(false);
        this.loaded.set(true);
        this.error.set(messageFor(err, 'Could not load teams.'));
      },
    });
  }

  /** The leader's display name for a team, or a fallback when unknown (R13.3). */
  protected leaderName(team: TeamView): string {
    return this.userNames().get(team.teamLeaderId) ?? `User #${team.teamLeaderId}`;
  }

  /** The row-level message for a team, if any (e.g. close blocked, R20.2). */
  protected rowMessage(team: TeamView): string | null {
    return this.rowMessages()[team.id] ?? null;
  }

  private setRowMessage(teamId: number, message: string | null): void {
    this.rowMessages.update((prev) => {
      const next = { ...prev };
      if (message === null) {
        delete next[teamId];
      } else {
        next[teamId] = message;
      }
      return next;
    });
  }

  // ── Create (R13.2) ──────────────────────────────────────────────────────────
  protected createTeam(): void {
    if (!this.canCreate()) {
      return;
    }
    const leaderId = this.newLeaderId();
    if (leaderId === null) {
      return;
    }
    const description = this.newDescription().trim();
    this.creating.set(true);
    this.createError.set(null);
    this.service
      .createTeam({
        title: this.newTitle().trim(),
        description: description === '' ? null : description,
        teamLeaderId: leaderId,
      })
      .subscribe({
        next: (team) => {
          this.creating.set(false);
          this.teams.update((prev) => sortTeams([...prev, team]));
          this.newTitle.set('');
          this.newDescription.set('');
          this.newLeaderId.set(null);
        },
        error: (err: unknown) => {
          this.creating.set(false);
          this.createError.set(messageFor(err, 'Could not create the team.'));
        },
      });
  }

  // ── Change leader (R13.3) ─────────────────────────────────────────────────
  protected changeLeader(team: TeamView, rawLeaderId: string): void {
    const leaderId = Number(rawLeaderId);
    if (!Number.isFinite(leaderId) || leaderId === team.teamLeaderId) {
      return;
    }
    this.setRowMessage(team.id, null);
    this.service.changeLeader(team.id, leaderId).subscribe({
      next: (updated) => this.replaceTeam(updated),
      error: (err: unknown) =>
        this.setRowMessage(team.id, messageFor(err, 'Could not change the leader.')),
    });
  }

  // ── Close (R13.3, R20.2) ────────────────────────────────────────────────────
  protected closeTeam(team: TeamView): void {
    if (team.isClosed) {
      return;
    }
    this.setRowMessage(team.id, null);
    this.service.closeTeam(team.id).subscribe({
      next: (updated) => this.replaceTeam(updated),
      error: (err: unknown) => {
        // A close blocked by non-closed requests is expected — surface it as a
        // gentle row message rather than a generic failure (R20.2).
        if (err instanceof ApiError && err.code === 'CONFLICT_OPEN_REQUESTS') {
          this.setRowMessage(
            team.id,
            'This team still has open requests and cannot be closed until they are closed.',
          );
          return;
        }
        this.setRowMessage(team.id, messageFor(err, 'Could not close the team.'));
      },
    });
  }

  /** Replace a team in the table with its updated view. */
  private replaceTeam(updated: TeamView): void {
    this.teams.update((prev) =>
      sortTeams(prev.map((t) => (t.id === updated.id ? updated : t))),
    );
  }

  protected trackByTeamId(_index: number, team: TeamView): number {
    return team.id;
  }
}

/** Sort teams by title then id, matching the backend list order (R13.3). */
function sortTeams(teams: TeamView[]): TeamView[] {
  return [...teams].sort((a, b) => a.title.localeCompare(b.title) || a.id - b.id);
}

/**
 * A friendly message for a failed call. An {@link ApiError} carries the
 * backend's message; anything else falls back to the supplied default so the
 * screen never shows a raw error.
 */
function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === 'FORBIDDEN') {
      return 'You are not permitted to manage teams.';
    }
    return err.message || fallback;
  }
  return fallback;
}
