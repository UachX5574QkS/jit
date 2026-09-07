import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiError } from '../../core/http/api-error';
import { FormFieldComponent } from '../../shared/fields/form-field';
import { fieldValidator, type FieldDefinition } from '../../shared/fields/field-types';
import { LocalDatePipe } from '../../shared/pipes/local-date.pipe';
import {
  SupportDetailService,
  toFieldDefinition,
  type AuditEntry,
  type OpenTimer,
  type RequestDetail as RequestDetailModel,
  type RequestFieldDetail,
  type RequestNote,
  type SupportFieldUpdate,
  type StartTimerBody,
  type TeamMember,
  type UpdateRequestBody,
} from './support-detail.service';
import { allowedTargets, isStatus, isStopState, type Status } from './status-transitions';
import { MIN_SLICE_MINUTES, elapsedMinutesSince, formatDuration } from './timer-duration';

/**
 * The SUPPORT-side request DETAIL view (route `/support/:id`) — a support
 * member's working view of one request (design: "Support detail"; R7, R9).
 *
 * ── What it shows (R7.1, R7.4, R17.4) ────────────────────────────────────────
 * On open it loads `GET /api/requests/:id`, which for a SUPPORT viewer of the
 * request's team INCLUDES internal notes and internal-note audit entries (R7.4,
 * R17.4). The screen renders the full request information, the pinned
 * task-version fields with their stored values, BOTH internal and external
 * notes, and the complete column-level audit trail (internal entries included).
 *
 * ── Full editing (R7.1) ──────────────────────────────────────────────────────
 * Support may edit ANY user-entered field via the shared {@link FormFieldComponent}s
 * bound to a reactive form (client-side validation MIRRORS the server via
 * {@link fieldValidator}), plus the Jira number and the estimated/actual start
 * dates. Save PATCHes `/requests/:id` with only the changed columns, then
 * re-loads the detail so the audit trail reflects the change.
 *
 * ── Status via the state machine (R9) ────────────────────────────────────────
 * The status control offers ONLY the legal next statuses for the current status
 * ({@link allowedTargets}, R9.4–9.7). On submit it PATCHes the chosen status;
 * an `INVALID_TRANSITION` from the server (e.g. the request moved underneath the
 * viewer) is surfaced gracefully and the detail is reloaded.
 *
 * ── Assignment (R7.2) ────────────────────────────────────────────────────────
 * The assignment drop-down lists every member of the request's team (loaded from
 * `GET /api/support/teams/:id/members`) plus an "Unassigned" option. Any team
 * member may assign a request to any other team member, or unassign it.
 *
 * ── Notes: internal and external (R7.3–7.6) ──────────────────────────────────
 * Support may add either an internal note (visible only to support; does not
 * flag the raiser's "Updated" indicator, R7.5) or an external note (visible to
 * the raiser; bumps their "Updated", R7.6). The add-note form has an
 * internal/external toggle; the choice travels as `isInternal` to the unified
 * notes endpoint.
 *
 * ── Timer UI: "Working on It" / "Back to Queue" (R8) ─────────────────────────
 * On load the screen also fetches the member's open timers for this request
 * (`GET /api/requests/:id/timers/mine`, R8.8). A "Working on It" button shows
 * ONLY when the request is ACTIVE and the member has no open timer on it (R8.1);
 * clicking starts a timer without changing the status (R8.2). While the member
 * has an open timer here the button becomes "Back to Queue" (R8.3); clicking it
 * stops the timer and opens a duration pop-up pre-filled with the elapsed
 * days/hours/minutes, EDITABLE, with the edited value required to be > 1 minute
 * (R8.4, R8.5) — a server `TIMER_MIN_DURATION` is surfaced too. If starting
 * would leave the member with timers running on OTHER requests, a
 * concurrent-timer prompt lets them stop those (`stopOthers:true`) or leave them
 * running (R8.8). Auto-stop-and-record on leaving ACTIVE is backend-owned
 * (task 7.4); after any status change the timer state is simply re-read.
 */

@Component({
  selector: 'app-support-detail',
  standalone: true,
  imports: [ReactiveFormsModule, FormFieldComponent, LocalDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './support-detail.html',
  styleUrl: './support-detail.scss',
})
export class SupportDetail {
  private readonly service = inject(SupportDetailService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  /** The request id from the route (`/support/:id`). */
  private readonly requestId = signal<number | null>(null);

  // ── Load state ──────────────────────────────────────────────────────────────

  protected readonly detail = signal<RequestDetailModel | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  /** The request's team members, for the assignment drop-down (R7.2). */
  protected readonly teamMembers = signal<readonly TeamMember[]>([]);

  // ── Edit / notes / action state ──────────────────────────────────────────────

  /** Whether the field edit form is open (R7.1). */
  protected readonly editing = signal(false);
  /** The reactive form driving field + jira + date edits; null until edit mode. */
  protected readonly form = signal<FormGroup | null>(null);
  /** Live mirror of `form.valid` (the group's identity is stable, R7.1 gate). */
  protected readonly formValid = signal(false);
  /** True while a PATCH/note request is in flight. */
  protected readonly busy = signal(false);
  /** A transient action error banner (save/status/assign/note failures). */
  protected readonly actionError = signal<string | null>(null);

  /** The add-note textarea value. */
  protected readonly noteBody = signal('');
  /** Whether the note being composed is internal (R7.3). Defaults to external. */
  protected readonly noteInternal = signal(false);

  // ── Timer state (R8) ──────────────────────────────────────────────────────────

  /** The member's open timer on THIS request, or null when none (R8.1, R8.8). */
  protected readonly myOpenTimer = signal<OpenTimer | null>(null);
  /** The member's open timers on OTHER requests, for the concurrent prompt (R8.8). */
  protected readonly otherOpenTimers = signal<readonly OpenTimer[]>([]);
  /** True while a timer start/stop request is in flight (R8). */
  protected readonly timerBusy = signal(false);
  /** A transient timer-action error banner. */
  protected readonly timerError = signal<string | null>(null);

  /**
   * The concurrent-timer prompt (R8.8): when set, the member is starting a timer
   * here while they already have timers running on `others`; they choose to stop
   * those or leave them running. Null when the prompt is closed.
   */
  protected readonly concurrentPrompt = signal<{ readonly others: readonly OpenTimer[] } | null>(
    null,
  );

  /**
   * The duration pop-up (R8.4, R8.5): when set, the member has clicked "Back to
   * Queue" and is confirming the recorded duration. `minutes` is the current
   * (editable) value pre-filled from the elapsed time; `elapsedMinutes` is the
   * original elapsed value shown as the presented time; `error` holds a
   * client/server validation message (the > 1 minute rule / TIMER_MIN_DURATION).
   */
  protected readonly durationPrompt = signal<{
    readonly startedAt: string;
    readonly elapsedMinutes: number;
    minutes: number;
    error: string | null;
  } | null>(null);

  constructor() {
    // Re-load whenever the :id param changes (e.g. navigating between requests).
    this.route.paramMap.subscribe((params) => {
      const raw = params.get('id');
      const id = raw !== null && /^\d+$/.test(raw) ? Number(raw) : null;
      this.requestId.set(id);
      if (id === null) {
        this.error.set('That request could not be found.');
        return;
      }
      this.load(id);
    });
  }

  // ── Derived view helpers ──────────────────────────────────────────────────────

  /** The ordered pinned-version fields to render (empty until loaded). */
  protected readonly fields = computed<readonly RequestFieldDetail[]>(
    () => this.detail()?.fields ?? [],
  );

  /** All notes — support sees BOTH internal and external (R7.4). */
  protected readonly notes = computed<readonly RequestNote[]>(() => this.detail()?.notes ?? []);

  /** The full audit trail, including internal-note entries (R17.4). */
  protected readonly auditTrail = computed<readonly AuditEntry[]>(
    () => this.detail()?.auditTrail ?? [],
  );

  /** True when the request is in a stop/closed state (R9.3). */
  protected readonly isClosed = computed(() => {
    const d = this.detail();
    return d !== null && isStatus(d.status) && isStopState(d.status);
  });

  /**
   * The legal next statuses for the current status (R9). Empty in a stop state,
   * so the status control is hidden there. Excludes the current status (a no-op
   * is not a transition).
   */
  protected readonly nextStatuses = computed<readonly Status[]>(() => {
    const d = this.detail();
    if (!d || !isStatus(d.status)) {
      return [];
    }
    return allowedTargets(d.status);
  });

  /** The assignment drop-down options: the team members (R7.2). */
  protected readonly assignmentOptions = computed<readonly TeamMember[]>(() => this.teamMembers());

  /** The current per-field validation error to show under a field (R7.1, R3). */
  protected fieldError(field: FieldDefinition): string | null {
    const control = this.form()?.get(String(field.id));
    const err = control?.errors?.['fieldError'] as { message?: string } | undefined;
    return control?.touched ? (err?.message ?? null) : null;
  }

  /** Map a detail field to the shared {@link FieldDefinition} the form uses. */
  protected toDefinition(field: RequestFieldDetail): FieldDefinition {
    return toFieldDefinition(field);
  }

  /** The read-mode display value for a field ("—" when unset). */
  protected displayValue(field: RequestFieldDetail): string {
    const v = field.value;
    return v === null || v.trim() === '' ? '—' : v;
  }

  /** The display name for the currently assigned member ("Unassigned" when none). */
  protected readonly assignedLabel = computed<string>(() => {
    const d = this.detail();
    if (!d || d.assignedMemberId === null) {
      return 'Unassigned';
    }
    const member = this.teamMembers().find((m) => m.userId === d.assignedMemberId);
    return member ? member.displayName : `Member #${d.assignedMemberId}`;
  });

  // ── Load ──────────────────────────────────────────────────────────────────────

  /** Fetch the request detail (R7.1) and its team members (R7.2). */
  protected load(id: number): void {
    this.loading.set(true);
    this.error.set(null);
    this.actionError.set(null);
    this.service.getDetail(id).subscribe({
      next: (detail) => {
        this.detail.set(detail);
        this.loading.set(false);
        // Any open edit form is now stale; drop it so a re-open rebuilds it.
        this.editing.set(false);
        this.form.set(null);
        this.loadTeamMembers(detail.teamId);
        // Re-read the member's timer state so the button reflects reality after
        // any status change (auto-stop on leaving ACTIVE is backend-owned, R8).
        this.loadTimers(detail.id);
      },
      error: () => {
        this.detail.set(null);
        this.loading.set(false);
        this.error.set('Could not load this request. Please try again.');
      },
    });
  }

  /** Load the request team's members for the assignment drop-down (R7.2). */
  private loadTeamMembers(teamId: number): void {
    this.service.listTeamMembers(teamId).subscribe({
      next: (members) => this.teamMembers.set(members),
      // A member-list failure must not break the detail view; the drop-down
      // simply falls back to "Unassigned" + the current member id.
      error: () => this.teamMembers.set([]),
    });
  }

  /**
   * Load the member's open timers relative to this request (R8.8): the open
   * timer on this request drives the button state ("Working on It" vs "Back to
   * Queue"), the others feed the concurrent-timer prompt. A failure must not
   * break the detail view — it falls back to "no open timers".
   */
  private loadTimers(id: number): void {
    this.service.listMyTimers(id).subscribe({
      next: (timers) => {
        this.myOpenTimer.set(timers.onThisRequest[0] ?? null);
        this.otherOpenTimers.set(timers.others);
      },
      error: () => {
        this.myOpenTimer.set(null);
        this.otherOpenTimers.set([]);
      },
    });
  }

  // ── Field / jira / date edits (R7.1) ───────────────────────────────────────────

  /** Enter edit mode: build the reactive form seeded from the current values (R7.1). */
  protected startEdit(): void {
    const d = this.detail();
    if (!d) {
      return;
    }
    this.actionError.set(null);
    const controls: Record<string, FormControl> = {
      jira: new FormControl(d.jiraNumber ?? '', { nonNullable: true }),
      estimatedStartDate: new FormControl(toDateInput(d.estimatedStartDate), {
        nonNullable: true,
      }),
      actualStartDate: new FormControl(toDateInput(d.actualStartDate), { nonNullable: true }),
    };
    for (const field of d.fields) {
      const def = toFieldDefinition(field);
      const initial: unknown =
        def.dataType === 'BOOLEAN' ? field.value === 'true' : (field.value ?? '');
      controls[String(field.taskFieldId)] = new FormControl(initial, {
        nonNullable: true,
        validators: [fieldValidator(def)],
      });
    }
    const form = new FormGroup(controls);
    this.form.set(form);
    this.formValid.set(form.valid);
    form.statusChanges.subscribe(() => this.formValid.set(form.valid));
    this.editing.set(true);
  }

  /** Leave edit mode without saving. */
  protected cancelEdit(): void {
    this.editing.set(false);
    this.form.set(null);
    this.actionError.set(null);
  }

  /** True when the edit form may be saved: it exists, is valid, and nothing is in flight. */
  protected readonly canSave = computed(
    () => this.editing() && this.form() !== null && this.formValid() && !this.busy(),
  );

  /**
   * Save the edited fields, Jira number, and estimated/actual start dates
   * (`PATCH /requests/:id`, R7.1). Sends every field value plus the jira/date
   * columns; the server re-validates against the pinned version. On success
   * re-loads the detail so the audit trail and values refresh.
   */
  protected save(): void {
    const d = this.detail();
    const form = this.form();
    if (!d || !form) {
      return;
    }
    if (!this.canSave()) {
      form.markAllAsTouched();
      return;
    }
    this.busy.set(true);
    this.actionError.set(null);

    const jiraRaw = stringify(form.get('jira')?.value).trim();
    const estRaw = stringify(form.get('estimatedStartDate')?.value).trim();
    const actRaw = stringify(form.get('actualStartDate')?.value).trim();
    const fieldValues: SupportFieldUpdate[] = d.fields.map((field) => {
      const raw = stringify(form.get(String(field.taskFieldId))?.value).trim();
      return { taskFieldId: field.taskFieldId, value: raw === '' ? null : raw };
    });

    const body: UpdateRequestBody = {
      jiraNumber: jiraRaw === '' ? null : jiraRaw,
      estimatedStartDate: estRaw === '' ? null : estRaw,
      actualStartDate: actRaw === '' ? null : actRaw,
      fieldValues,
    };

    this.service.update(d.id, body).subscribe({
      next: () => {
        this.busy.set(false);
        this.load(d.id);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.actionError.set(messageFor(err, 'Could not save your changes. Please try again.'));
      },
    });
  }

  // ── Status change (R9) ──────────────────────────────────────────────────────────

  /**
   * Change the request's status via the state machine (`PATCH /requests/:id`,
   * R9). The chosen `next` is one of the legal targets surfaced by
   * {@link nextStatuses}; an `INVALID_TRANSITION` from the server (the request
   * moved underneath the viewer) is surfaced gracefully and the detail reloaded.
   */
  protected changeStatus(next: string): void {
    const d = this.detail();
    if (!d || this.busy() || next === '' || !isStatus(next) || next === d.status) {
      return;
    }
    this.busy.set(true);
    this.actionError.set(null);
    this.service.update(d.id, { status: next }).subscribe({
      next: () => {
        this.busy.set(false);
        this.load(d.id);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        if (err instanceof ApiError && err.code === 'INVALID_TRANSITION') {
          // Reload so the screen reflects the request's real current status,
          // then surface the message (load() clears actionError first, so set
          // it AFTER kicking the reload).
          this.load(d.id);
          this.actionError.set(
            'That status change is no longer allowed — the request may have moved. Reloading…',
          );
          return;
        }
        this.actionError.set(messageFor(err, 'Could not change the status. Please try again.'));
      },
    });
  }

  // ── Assignment (R7.2) ─────────────────────────────────────────────────────────

  /**
   * Change the assignment (`PATCH /requests/:id`, R7.2). A `raw` of "" means
   * UNASSIGN (null); otherwise a member id. A no-op is ignored. On success the
   * detail reloads so the audit trail reflects the change.
   */
  protected changeAssignment(raw: string): void {
    const d = this.detail();
    if (!d || this.busy()) {
      return;
    }
    const next: number | null = raw === '' ? null : Number(raw);
    if (next !== null && !Number.isSafeInteger(next)) {
      return;
    }
    if (next === d.assignedMemberId) {
      return; // No-op.
    }
    this.busy.set(true);
    this.actionError.set(null);
    this.service.update(d.id, { assignedMemberId: next }).subscribe({
      next: () => {
        this.busy.set(false);
        this.load(d.id);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.actionError.set(messageFor(err, 'Could not change the assignment. Please try again.'));
      },
    });
  }

  // ── Notes: internal or external (R7.3–7.6) ───────────────────────────────────

  /** Handle input in the add-note textarea. */
  protected onNoteInput(value: string): void {
    this.noteBody.set(value);
  }

  /** Set whether the composed note is internal (R7.3). */
  protected setNoteInternal(isInternal: boolean): void {
    this.noteInternal.set(isInternal);
  }

  /** True when the note can be added (non-blank body, nothing in flight). */
  protected readonly canAddNote = computed(() => this.noteBody().trim() !== '' && !this.busy());

  /**
   * Add a note (`POST .../notes`, R7.3). The internal/external choice travels as
   * `isInternal`; an internal note does not flag the raiser's "Updated"
   * indicator (R7.5), an external one does (R7.6). On success the detail reloads
   * so the new note (and any audit entry) appears.
   */
  protected addNote(): void {
    const d = this.detail();
    const body = this.noteBody().trim();
    if (!d || body === '' || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.actionError.set(null);
    this.service.addNote(d.id, body, this.noteInternal()).subscribe({
      next: () => {
        this.busy.set(false);
        this.noteBody.set('');
        this.load(d.id);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.actionError.set(messageFor(err, 'Could not add your note. Please try again.'));
      },
    });
  }

  // ── Timer: "Working on It" / "Back to Queue" (R8) ───────────────────────────────

  /** True when the request is ACTIVE — the only status where a timer may run (R8.1). */
  protected readonly isActive = computed(() => this.detail()?.status === 'ACTIVE');

  /** True when the member has an open timer on THIS request (R8.3, R8.8). */
  protected readonly hasOpenTimer = computed(() => this.myOpenTimer() !== null);

  /**
   * Show "Working on It" ONLY when the request is ACTIVE and the member has no
   * open timer on it (R8.1). Once a timer runs the button becomes "Back to
   * Queue" (R8.3), so the two are mutually exclusive.
   */
  protected readonly showWorkingOnIt = computed(() => this.isActive() && !this.hasOpenTimer());

  /** Show "Back to Queue" whenever the member has an open timer on this request (R8.3). */
  protected readonly showBackToQueue = computed(() => this.hasOpenTimer());

  /**
   * Start a timer on this request (`POST .../timer/start`, R8.1, R8.2). Before
   * starting, if the member already has open timers on OTHER requests we open
   * the concurrent-timer prompt (R8.8) instead of starting immediately, so they
   * can decide whether to stop those. Otherwise we start directly.
   */
  protected workOnIt(): void {
    const d = this.detail();
    if (!d || this.timerBusy() || this.hasOpenTimer()) {
      return;
    }
    const others = this.otherOpenTimers();
    if (others.length > 0) {
      // Resolve the concurrent-timer prompt first (R8.8).
      this.concurrentPrompt.set({ others });
      return;
    }
    this.startTimer(d.id, {});
  }

  /**
   * Resolve the concurrent-timer prompt (R8.8) and start the timer: `stopOthers`
   * true stops-and-records the member's other open timers first, false leaves
   * them running. Either way this request's timer is started.
   */
  protected resolveConcurrent(stopOthers: boolean): void {
    const d = this.detail();
    this.concurrentPrompt.set(null);
    if (!d || this.timerBusy() || this.hasOpenTimer()) {
      return;
    }
    this.startTimer(d.id, { stopOthers });
  }

  /** Dismiss the concurrent-timer prompt without starting a timer (R8.8). */
  protected cancelConcurrent(): void {
    this.concurrentPrompt.set(null);
  }

  /** Issue the start-timer call and reflect the resulting state (R8.2, R8.8). */
  private startTimer(id: number, body: StartTimerBody): void {
    this.timerBusy.set(true);
    this.timerError.set(null);
    this.service.startTimer(id, body).subscribe({
      next: (result) => {
        this.timerBusy.set(false);
        this.myOpenTimer.set(result.timer);
        // If others were stopped they are no longer open; otherwise they remain.
        this.otherOpenTimers.set(result.stoppedOthers ? [] : result.otherOpenTimers);
      },
      error: (err: unknown) => {
        this.timerBusy.set(false);
        // The request may have left ACTIVE underneath us (INVALID_TRANSITION);
        // reload so the button reflects the real state.
        if (err instanceof ApiError && err.code === 'INVALID_TRANSITION') {
          this.load(id);
          this.timerError.set(
            'This request is no longer Active, so a timer cannot be started. Reloading…',
          );
          return;
        }
        this.timerError.set(messageFor(err, 'Could not start the timer. Please try again.'));
      },
    });
  }

  /**
   * Click "Back to Queue" (R8.3, R8.4): open the duration pop-up pre-filled with
   * the elapsed days/hours/minutes since the timer started, EDITABLE (R8.5). The
   * slice is only recorded when the member confirms.
   */
  protected backToQueue(): void {
    const timer = this.myOpenTimer();
    if (!timer || this.timerBusy()) {
      return;
    }
    const elapsed = elapsedMinutesSince(timer.startedAt);
    this.durationPrompt.set({
      startedAt: timer.startedAt,
      elapsedMinutes: elapsed,
      minutes: elapsed,
      error: null,
    });
  }

  /** The presented elapsed time as "Xd Yh Zm" for the duration pop-up (R8.4). */
  protected readonly durationSummary = computed<string>(() => {
    const p = this.durationPrompt();
    return p ? formatDuration(p.elapsedMinutes) : '';
  });

  /** Handle edits to the duration input (whole minutes) in the pop-up (R8.5). */
  protected onDurationInput(raw: string): void {
    const prompt = this.durationPrompt();
    if (!prompt) {
      return;
    }
    const value = Number(raw);
    const minutes = Number.isFinite(value) ? Math.floor(value) : NaN;
    this.durationPrompt.set({
      ...prompt,
      minutes: Number.isNaN(minutes) ? prompt.minutes : minutes,
      error: null,
    });
  }

  /** Dismiss the duration pop-up WITHOUT recording — the timer stays running (R8.5). */
  protected cancelDuration(): void {
    this.durationPrompt.set(null);
  }

  /** True when the value in the duration pop-up is not the presented elapsed value. */
  private durationWasEdited(prompt: { elapsedMinutes: number; minutes: number }): boolean {
    return prompt.minutes !== prompt.elapsedMinutes;
  }

  /**
   * Confirm the duration pop-up (R8.6): stop the timer and record the slice. If
   * the member EDITED the value it must be > 1 minute (R8.5) — client-validated
   * here, and a server `TIMER_MIN_DURATION` is surfaced in the pop-up too. An
   * unedited value is sent without `durationMinutes` so the server records the
   * elapsed time.
   */
  protected confirmDuration(): void {
    const d = this.detail();
    const prompt = this.durationPrompt();
    if (!d || !prompt || this.timerBusy()) {
      return;
    }
    const edited = this.durationWasEdited(prompt);
    if (edited && prompt.minutes <= MIN_SLICE_MINUTES) {
      this.durationPrompt.set({
        ...prompt,
        error: 'The recorded time must be greater than 1 minute.',
      });
      return;
    }

    this.timerBusy.set(true);
    this.timerError.set(null);
    // Only send an edited duration; an unchanged value lets the server record
    // the elapsed time (R8.4).
    const body = edited ? { durationMinutes: prompt.minutes } : {};
    this.service.stopTimer(d.id, body).subscribe({
      next: () => {
        this.timerBusy.set(false);
        this.durationPrompt.set(null);
        this.myOpenTimer.set(null);
        // Reload so the audit trail / "(Working On)" state and timers refresh.
        this.load(d.id);
      },
      error: (err: unknown) => {
        this.timerBusy.set(false);
        if (err instanceof ApiError && err.code === 'TIMER_MIN_DURATION') {
          const current = this.durationPrompt();
          if (current) {
            this.durationPrompt.set({
              ...current,
              error: messageFor(err, 'The recorded time must be greater than 1 minute.'),
            });
          }
          return;
        }
        // No open timer to stop (someone/something already stopped it) — reload.
        if (err instanceof ApiError && err.code === 'NOT_FOUND') {
          this.durationPrompt.set(null);
          this.load(d.id);
          return;
        }
        this.timerError.set(messageFor(err, 'Could not record the time. Please try again.'));
      },
    });
  }

  /** Stable trackBy for the concurrent-timer prompt list. */
  protected trackByTimerId(_index: number, timer: OpenTimer): number {
    return timer.id;
  }

  // ── Navigation ─────────────────────────────────────────────────────────────────

  /** Go back to the Support queue. */
  protected back(): void {
    void this.router.navigate(['/support']);
  }

  /** Stable trackBy for note / audit loops. */
  protected trackById(_index: number, item: { readonly id: number }): number {
    return item.id;
  }

  /** Stable trackBy for the pinned-version field loop. */
  protected trackByTaskFieldId(_index: number, field: RequestFieldDetail): number {
    return field.taskFieldId;
  }

  /** Stable trackBy for the team-member drop-down loop. */
  protected trackByUserId(_index: number, member: TeamMember): number {
    return member.userId;
  }

  /** Stable trackBy for the next-status loop. */
  protected trackByStatus(_index: number, status: Status): string {
    return status;
  }
}

/** Coerce a control value to the string the backend expects (R7.1). */
function stringify(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return String(value);
}

/**
 * Convert a backend ISO timestamp to the `YYYY-MM-DD` value a native date input
 * expects, using the UTC calendar date. Returns "" for null/unparseable so the
 * control renders empty.
 */
function toDateInput(iso: string | null): string {
  if (iso === null || iso.trim() === '') {
    return '';
  }
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return '';
  }
  return new Date(ms).toISOString().slice(0, 10);
}

/** Prefer the server's error message when it is an {@link ApiError}, else a fallback. */
function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.message.trim() !== '') {
    return err.message;
  }
  return fallback;
}
