import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { CurrentUserService } from '../../core/auth/current-user.service';
import { FormFieldComponent } from '../../shared/fields/form-field';
import { fieldValidator, type FieldDefinition } from '../../shared/fields/field-types';
import { LocalDatePipe } from '../../shared/pipes/local-date.pipe';
import { CLONE_DRAFT_STATE_KEY } from '../new/new-workflow';
import {
  RequestDetailService,
  toFieldDefinition,
  type AuditEntry,
  type RequestDetail as RequestDetailModel,
  type RequestFieldDetail,
  type RequestNote,
  type UserFieldUpdate,
} from './request-detail.service';

/**
 * The user-side Requests DETAIL view (route `/requests/:id`) — the raiser's
 * window onto one request (design: "Requests detail"; R5).
 *
 * ── What it shows (R5.1, R5.2) ───────────────────────────────────────────────
 * On open it loads `GET /api/requests/:id`, which for a NON-support viewer
 * already excludes support internal notes and internal-note audit entries
 * (R5.1, R17.4) and records the viewer's `last_seen`, clearing their "Updated"
 * indicator (R5.2). The screen renders the full request information, the pinned
 * task-version fields with their stored values, the external notes, and the
 * column-level audit trail exactly as received — it never has to filter
 * internal content itself.
 *
 * ── User-field edits (R5.3, R5.4) ────────────────────────────────────────────
 *   • Edit my fields — the raiser toggles an edit mode that swaps the read-only
 *     field values for the shared {@link FormFieldComponent}s bound to a reactive
 *     form (one control per field, plus the always-editable Jira). Client-side
 *     validation MIRRORS the server via {@link fieldValidator}: a mandatory field
 *     cannot be blanked (R5.4) and each value must satisfy its data type (R3);
 *     Save is disabled until the form is valid. Save PATCHes
 *     `/user-fields`, then re-loads the detail so the audit trail reflects the
 *     change.
 *   • Add a note — the raiser posts an EXTERNAL note (`POST .../notes`,
 *     is_internal=false) visible to support (R5.3); on success the detail
 *     reloads so the new note appears.
 *
 * ── Status actions (R5.5–5.8) ────────────────────────────────────────────────
 * The raiser may only change status via two constrained paths (R5.7 — no other
 * status change is offered):
 *   • Cancel  — shown to the RAISER when the request is in a NON-stop state,
 *     sets the status to CANCELLED (R5.5).
 *   • Reopen  — shown when the request is CANCELLED and the current user is the
 *     one who cancelled it (derived from the audit trail's most-recent
 *     status→CANCELLED entry, matching the server's raiser-who-cancelled gate),
 *     returning the status to NEW (R5.6).
 * Clone is offered to ANY viewer (R5.8): it fetches a pre-populated draft and
 * navigates into the New workflow opened at Step 2 with the original's values.
 */

/** The stop (closed) statuses — Cancel is hidden in these; Reopen only in CANCELLED (R9.3, R5.5–5.6). */
const STOP_STATUSES: ReadonlySet<string> = new Set(['COMPLETE', 'REJECTED', 'CANCELLED']);

@Component({
  selector: 'app-request-detail',
  standalone: true,
  imports: [ReactiveFormsModule, FormFieldComponent, LocalDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './request-detail.html',
  styleUrl: './request-detail.scss',
})
export class RequestDetail {
  private readonly service = inject(RequestDetailService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly currentUser = inject(CurrentUserService);

  /** The request id from the route (`/requests/:id`). */
  private readonly requestId = signal<number | null>(null);

  // ── Load state ──────────────────────────────────────────────────────────────

  protected readonly detail = signal<RequestDetailModel | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  // ── Edit / notes / action state ──────────────────────────────────────────────

  /** Whether the user-field edit form is open (R5.4). */
  protected readonly editing = signal(false);
  /** The reactive form driving field edits; null until edit mode is entered. */
  protected readonly form = signal<FormGroup | null>(null);
  /** Live mirror of `form.valid` (the group's identity is stable, R5.4 gate). */
  protected readonly formValid = signal(false);
  /** True while a PATCH/note/cancel/reopen/clone request is in flight. */
  protected readonly busy = signal(false);
  /** A transient action error banner (save/note/action failures). */
  protected readonly actionError = signal<string | null>(null);

  /** The add-note textarea value. */
  protected readonly noteBody = signal('');

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

  /** Only EXTERNAL notes are shown here; the backend already hides internal ones (R5.1). */
  protected readonly externalNotes = computed<readonly RequestNote[]>(() =>
    (this.detail()?.notes ?? []).filter((n) => !n.isInternal),
  );

  /** The audit trail as received (internal-note entries already excluded, R5.1/R17.4). */
  protected readonly auditTrail = computed<readonly AuditEntry[]>(
    () => this.detail()?.auditTrail ?? [],
  );

  /** True when the current user raised this request (drives Cancel/Reopen, R5.5–5.6). */
  protected readonly isRaiser = computed(() => {
    const d = this.detail();
    const me = this.currentUser.snapshot();
    return d !== null && me !== null && d.raisedById === me.id;
  });

  /** True when the request is in a stop/closed state (R9.3). */
  protected readonly isClosed = computed(() => {
    const d = this.detail();
    return d !== null && STOP_STATUSES.has(d.status);
  });

  /** Cancel is offered to the raiser only while the request is NON-stop (R5.5). */
  protected readonly canCancel = computed(() => this.isRaiser() && !this.isClosed());

  /**
   * Reopen is offered when the request is CANCELLED and the current user is the
   * one who cancelled it (R5.6). "Who cancelled" is the actor of the most-recent
   * status→CANCELLED audit entry, mirroring the server's raiser-who-cancelled
   * gate; the server re-checks and would 403 otherwise.
   */
  protected readonly canReopen = computed(() => {
    const d = this.detail();
    const me = this.currentUser.snapshot();
    if (!d || !me || d.status !== 'CANCELLED') {
      return false;
    }
    return this.cancelledById() === me.id;
  });

  /**
   * The id of the user who cancelled the request, from the most-recent status
   * change to CANCELLED in the audit trail, or `null` when none is found.
   */
  private cancelledById(): number | null {
    const entries = this.auditTrail()
      .filter((a) => a.fieldName === 'status' && a.newValue === 'CANCELLED')
      .sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt));
    return entries.length > 0 ? entries[0].changedById : null;
  }

  /** The current per-field validation error to show under a field (R5.4, R3). */
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

  // ── Load ──────────────────────────────────────────────────────────────────────

  /** Fetch the request detail (R5.1); opening records `last_seen` server-side (R5.2). */
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
      },
      error: () => {
        this.detail.set(null);
        this.loading.set(false);
        this.error.set('Could not load this request. Please try again.');
      },
    });
  }

  // ── User-field edits (R5.4) ────────────────────────────────────────────────────

  /** Enter edit mode: build the reactive form seeded from the current values (R5.4). */
  protected startEdit(): void {
    const d = this.detail();
    if (!d) {
      return;
    }
    this.actionError.set(null);
    const controls: Record<string, FormControl> = {
      jira: new FormControl(d.jiraNumber ?? '', { nonNullable: true }),
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
   * Save the edited Jira number and field values (`PATCH .../user-fields`, R5.4).
   * Sends the Jira number (null when cleared) and every field value; the server
   * re-validates and rejects blanking a mandatory field. On success re-loads the
   * detail so the audit trail and values refresh.
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
    const fieldValues: UserFieldUpdate[] = d.fields.map((field) => {
      const raw = stringify(form.get(String(field.taskFieldId))?.value).trim();
      return { taskFieldId: field.taskFieldId, value: raw === '' ? null : raw };
    });

    this.service
      .updateUserFields(d.id, { jiraNumber: jiraRaw === '' ? null : jiraRaw, fieldValues })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.load(d.id);
        },
        error: () => {
          this.busy.set(false);
          this.actionError.set(
            'Could not save your changes. Please check the fields and try again.',
          );
        },
      });
  }

  // ── Notes (R5.3) ────────────────────────────────────────────────────────────────

  /** Handle input in the add-note textarea. */
  protected onNoteInput(value: string): void {
    this.noteBody.set(value);
  }

  /** True when the note can be added (non-blank body, nothing in flight). */
  protected readonly canAddNote = computed(() => this.noteBody().trim() !== '' && !this.busy());

  /** Add an external note visible to support members (`POST .../notes`, R5.3). */
  protected addNote(): void {
    const d = this.detail();
    const body = this.noteBody().trim();
    if (!d || body === '' || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.actionError.set(null);
    this.service.addNote(d.id, body).subscribe({
      next: () => {
        this.busy.set(false);
        this.noteBody.set('');
        this.load(d.id);
      },
      error: () => {
        this.busy.set(false);
        this.actionError.set('Could not add your note. Please try again.');
      },
    });
  }

  // ── Status actions (R5.5–5.6) ──────────────────────────────────────────────────

  /** Cancel this request (raiser, non-stop → CANCELLED, R5.5). */
  protected cancel(): void {
    const d = this.detail();
    if (!d || !this.canCancel() || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.actionError.set(null);
    this.service.cancel(d.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.load(d.id);
      },
      error: () => {
        this.busy.set(false);
        this.actionError.set('Could not cancel this request. Please try again.');
      },
    });
  }

  /** Reopen a request the current user cancelled (CANCELLED → NEW, R5.6). */
  protected reopen(): void {
    const d = this.detail();
    if (!d || !this.canReopen() || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.actionError.set(null);
    this.service.reopen(d.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.load(d.id);
      },
      error: () => {
        this.busy.set(false);
        this.actionError.set('Could not reopen this request. Please try again.');
      },
    });
  }

  // ── Clone (R5.8) ────────────────────────────────────────────────────────────────

  /**
   * Clone this request: fetch a pre-populated draft (`POST .../clone`, R5.8) and
   * navigate into the New workflow opened at Step 2 with the original's values,
   * handing the draft over in router state. Any viewer may clone.
   */
  protected clone(): void {
    const d = this.detail();
    if (!d || this.busy()) {
      return;
    }
    this.busy.set(true);
    this.actionError.set(null);
    this.service.clone(d.id).subscribe({
      next: (draft) => {
        this.busy.set(false);
        void this.router.navigate(['/new'], {
          state: { [CLONE_DRAFT_STATE_KEY]: draft },
        });
      },
      error: () => {
        this.busy.set(false);
        this.actionError.set('Could not clone this request. Please try again.');
      },
    });
  }

  /** Go back to the Requests list. */
  protected back(): void {
    void this.router.navigate(['/requests']);
  }

  /** Stable trackBy for note / audit / field loops. */
  protected trackById(_index: number, item: { readonly id: number }): number {
    return item.id;
  }

  /** Stable trackBy for the pinned-version field loop. */
  protected trackByTaskFieldId(_index: number, field: RequestFieldDetail): number {
    return field.taskFieldId;
  }
}

/** Coerce a control value to the string the backend expects (R5.4). */
function stringify(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return String(value);
}
