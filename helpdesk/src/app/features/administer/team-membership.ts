import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiError } from '../../core/http/api-error';
import { CurrentUserService } from '../../core/auth/current-user.service';
import { LocalDatePipe } from '../../shared/pipes/local-date.pipe';
import {
  TeamMembershipService,
  type LeadableTeam,
  type TeamMemberView,
  type TeamWithMembersView,
} from './team-membership.service';

/**
 * The Team-Leader "Team Membership" screen (task 14.2; design: "Administer —
 * team-leader tiles"; R15, R20.3).
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 * For a team the current user LEADS, a team leader can:
 *   • pick which of their teams to manage (from the additive role superset's
 *     `teamsLed`, labelled from the open-teams read) (R15.1);
 *   • view and UPDATE the team's details — title and description (R15.2);
 *   • change MEMBERSHIP — add a member by user id, or remove an existing member
 *     (R15.3). Removal is guarded server-side: a member with non-closed requests
 *     under the team cannot be removed, surfaced GRACEFULLY as a per-member
 *     `CONFLICT_OPEN_REQUESTS` message rather than an error banner (R15.4/R20.3).
 *
 * ── AuthZ is server-side ─────────────────────────────────────────────────────
 * The route is team-leader-guarded for UX; the real "leader-of-THIS-team"
 * boundary is enforced on every `/team-leader/teams/:id` endpoint (R15). A
 * `FORBIDDEN` (e.g. a leader opening a team they do not lead) is shown as a
 * friendly message, never a crash.
 *
 * ── Adding members without a leader-scoped directory ─────────────────────────
 * The backend exposes no leader-safe "all users" list (the admin users list is
 * administrator-only), and the `addMemberIds` contract takes numeric ids. So
 * adding is by user id — the safe, contract-accurate affordance a leader can
 * use — while the current membership table shows who is already on the team.
 */
@Component({
  selector: 'app-team-membership',
  standalone: true,
  imports: [FormsModule, RouterLink, LocalDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './team-membership.html',
  styleUrl: './team-membership.scss',
})
export class TeamMembership {
  private readonly service = inject(TeamMembershipService);
  private readonly currentUser = inject(CurrentUserService);

  // ── Team picker ─────────────────────────────────────────────────────────────
  /** The ids of teams the current user leads (from the role superset, R15.1). */
  protected readonly ledTeamIds = computed<readonly number[]>(
    () => this.currentUser.user()?.teamsLed ?? [],
  );

  /** The teams the current user may manage, labelled with a title where known. */
  protected readonly leadableTeams = signal<LeadableTeam[]>([]);

  /** The id of the team currently being managed, or `null` before a choice. */
  protected readonly selectedTeamId = signal<number | null>(null);

  // ── Loaded team ─────────────────────────────────────────────────────────────
  protected readonly team = signal<TeamWithMembersView | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  // ── Details edit form ────────────────────────────────────────────────────────
  protected readonly editTitle = signal('');
  protected readonly editDescription = signal('');
  protected readonly savingDetails = signal(false);
  protected readonly detailsError = signal<string | null>(null);
  protected readonly detailsSaved = signal(false);

  /** Details can be saved when a team is loaded, a title is present, and idle. */
  protected readonly canSaveDetails = computed(
    () => this.team() !== null && this.editTitle().trim() !== '' && !this.savingDetails(),
  );

  // ── Add-member form ──────────────────────────────────────────────────────────
  protected readonly addUserId = signal('');
  protected readonly addingMember = signal(false);
  protected readonly addError = signal<string | null>(null);

  /** True when the add form carries a positive-integer user id and is idle. */
  protected readonly canAddMember = computed(() => {
    const id = parsePositiveInt(this.addUserId());
    return id !== null && this.team() !== null && !this.addingMember();
  });

  /** Per-member message (e.g. the removal conflict), keyed by user id (R20.3). */
  protected readonly memberMessages = signal<Readonly<Record<number, string>>>({});

  /** True once the leader has chosen a team but it is still loading/empty. */
  protected readonly hasSelection = computed(() => this.selectedTeamId() !== null);

  constructor() {
    this.loadLeadableTeams();
  }

  /**
   * Build the team picker: intersect the open-teams list with the leader's
   * `teamsLed` so each option has a title. A led team missing from the open
   * list (e.g. closed) still appears with an id-based label so it stays
   * manageable.
   */
  private loadLeadableTeams(): void {
    const ledIds = this.ledTeamIds();
    this.service.listOpenTeams().subscribe({
      next: (teams) => this.leadableTeams.set(mergeLeadable(ledIds, teams)),
      // The picker labelling is best-effort; on failure fall back to id labels
      // so the leader can still act (server enforces the real boundary).
      error: () => this.leadableTeams.set(ledIds.map((id) => ({ id, title: `Team #${id}` }))),
    });

    // Auto-select when the leader leads exactly one team.
    if (ledIds.length === 1) {
      this.selectTeam(ledIds[0]);
    }
  }

  /** The label for a team option in the picker. */
  protected teamLabel(teamId: number): string {
    return this.leadableTeams().find((t) => t.id === teamId)?.title ?? `Team #${teamId}`;
  }

  /** Handle the picker change (raw string from the <select>). */
  protected onSelectTeam(raw: string): void {
    const id = parsePositiveInt(raw);
    if (id === null) {
      this.selectedTeamId.set(null);
      this.team.set(null);
      return;
    }
    this.selectTeam(id);
  }

  /** Load the chosen team's details + membership (R15.2/15.3). */
  protected selectTeam(teamId: number): void {
    this.selectedTeamId.set(teamId);
    this.team.set(null);
    this.error.set(null);
    this.detailsError.set(null);
    this.detailsSaved.set(false);
    this.addError.set(null);
    this.memberMessages.set({});
    this.loading.set(true);
    this.service.getTeam(teamId).subscribe({
      next: (data) => {
        this.loading.set(false);
        this.applyTeam(data);
      },
      error: (err: unknown) => {
        this.loading.set(false);
        this.error.set(messageFor(err, 'Could not load this team.'));
      },
    });
  }

  /** Store a loaded/updated team and sync the details form to it. */
  private applyTeam(data: TeamWithMembersView): void {
    this.team.set(data);
    this.editTitle.set(data.team.title);
    this.editDescription.set(data.team.description ?? '');
  }

  // ── Update details (R15.2) ────────────────────────────────────────────────
  protected saveDetails(): void {
    const current = this.team();
    if (!current || !this.canSaveDetails()) {
      return;
    }
    const title = this.editTitle().trim();
    const description = this.editDescription().trim();
    // Only send fields that actually changed to avoid an empty/no-op patch.
    const body: { title?: string; description?: string | null } = {};
    if (title !== current.team.title) {
      body.title = title;
    }
    const nextDescription = description === '' ? null : description;
    if (nextDescription !== current.team.description) {
      body.description = nextDescription;
    }
    if (body.title === undefined && body.description === undefined) {
      this.detailsSaved.set(true);
      return;
    }

    this.savingDetails.set(true);
    this.detailsError.set(null);
    this.detailsSaved.set(false);
    this.service.updateTeam(current.team.id, body).subscribe({
      next: (data) => {
        this.savingDetails.set(false);
        this.detailsSaved.set(true);
        this.applyTeam(data);
      },
      error: (err: unknown) => {
        this.savingDetails.set(false);
        this.detailsError.set(messageFor(err, 'Could not update the team details.'));
      },
    });
  }

  // ── Add a member (R15.3) ──────────────────────────────────────────────────
  protected addMember(): void {
    const current = this.team();
    const userId = parsePositiveInt(this.addUserId());
    if (!current || userId === null) {
      return;
    }
    if (current.members.some((m) => m.userId === userId)) {
      this.addError.set('That user is already a member of this team.');
      return;
    }
    this.addingMember.set(true);
    this.addError.set(null);
    this.service.updateTeam(current.team.id, { addMemberIds: [userId] }).subscribe({
      next: (data) => {
        this.addingMember.set(false);
        this.addUserId.set('');
        this.applyTeam(data);
      },
      error: (err: unknown) => {
        this.addingMember.set(false);
        this.addError.set(messageFor(err, 'Could not add the member.'));
      },
    });
  }

  // ── Remove a member (R15.3, R15.4/R20.3) ──────────────────────────────────
  protected removeMember(member: TeamMemberView): void {
    const current = this.team();
    if (!current) {
      return;
    }
    this.setMemberMessage(member.userId, null);
    this.service.updateTeam(current.team.id, { removeMemberIds: [member.userId] }).subscribe({
      next: (data) => this.applyTeam(data),
      error: (err: unknown) => {
        // A removal blocked by the member's non-closed requests is expected —
        // surface it as a gentle per-member message, not a failure (R20.3).
        if (err instanceof ApiError && err.code === 'CONFLICT_OPEN_REQUESTS') {
          this.setMemberMessage(
            member.userId,
            `${member.displayName} still has open requests under this team and cannot be removed until they are closed.`,
          );
          return;
        }
        this.setMemberMessage(member.userId, messageFor(err, 'Could not remove the member.'));
      },
    });
  }

  /** The per-member message for a user, if any (e.g. removal blocked, R20.3). */
  protected memberMessage(member: TeamMemberView): string | null {
    return this.memberMessages()[member.userId] ?? null;
  }

  private setMemberMessage(userId: number, message: string | null): void {
    this.memberMessages.update((prev) => {
      const next = { ...prev };
      if (message === null) {
        delete next[userId];
      } else {
        next[userId] = message;
      }
      return next;
    });
  }

  protected trackByUserId(_index: number, member: TeamMemberView): number {
    return member.userId;
  }
}

/** Parse a positive integer from a string/number, or `null` when malformed. */
function parsePositiveInt(raw: string | number): number | null {
  const value = typeof raw === 'number' ? raw : raw.trim();
  if (typeof value === 'string' && !/^\d+$/.test(value)) {
    return null;
  }
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Build the leadable-team option list: every id the leader leads, labelled from
 * the open-teams list where present, else with an id-based fallback so a closed
 * (not-in-open-list) team the leader still leads remains selectable.
 */
function mergeLeadable(ledIds: readonly number[], openTeams: LeadableTeam[]): LeadableTeam[] {
  const titleById = new Map(openTeams.map((t) => [t.id, t.title]));
  return [...ledIds]
    .map((id) => ({ id, title: titleById.get(id) ?? `Team #${id}` }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id - b.id);
}

/**
 * A friendly message for a failed call. An {@link ApiError} carries the
 * backend's message; a `FORBIDDEN` is worded for this screen; anything else
 * falls back to the supplied default so the screen never shows a raw error.
 */
function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === 'FORBIDDEN') {
      return 'You can only manage a team you lead.';
    }
    return err.message || fallback;
  }
  return fallback;
}
