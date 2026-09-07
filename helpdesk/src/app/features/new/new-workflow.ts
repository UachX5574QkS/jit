import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { FormFieldComponent } from '../../shared/fields/form-field';
import { fieldValidator, type FieldDefinition } from '../../shared/fields/field-types';
import type { CloneDraft } from '../requests/request-detail.service';
import {
  WorkflowService,
  type ActiveTask,
  type CreatedRequest,
  type CurrentVersion,
  type EnteredValue,
  type OpenTeam,
  type ReviewSummary,
} from './workflow.service';

/**
 * The router-state key under which the Requests detail Clone action hands a
 * pre-populated draft to the New workflow (R5.8). The workflow reads it from
 * `history.state` on construction and, when present, jumps straight to Step 2
 * pre-filled with the source request's values.
 */
export const CLONE_DRAFT_STATE_KEY = 'cloneDraft';

/** The three workflow steps, 1-indexed to match the UI (R2.2). */
export type StepNumber = 1 | 2 | 3;

/** Seed values used to pre-populate the Step 2 form when cloning (R5.8). */
interface FormSeed {
  readonly title: string;
  readonly jira: string;
  /** Field values keyed by `taskFieldId`, as strings ("true"/"false" for BOOLEAN). */
  readonly values: ReadonlyMap<number, string>;
}

/** The visual state of a step node in the horizontal stepper (UI spec). */
export type StepState = 'completed' | 'running' | 'locked';

/** One step node rendered in the horizontal step row. */
export interface StepNode {
  readonly number: StepNumber;
  readonly label: string;
  readonly icon: 'team' | 'details' | 'review';
  readonly state: StepState;
}

/**
 * The "New" request workflow — a three-step wizard (design: "New workflow";
 * R2, R3).
 *
 * ── The three steps (R2.2) ───────────────────────────────────────────────────
 *   1. Team and Task  — choose an OPEN team then one of its ACTIVE tasks (R2.3).
 *   2. Request Details — the pinned task version's typed fields via the shared
 *      form-field components, plus the always-present optional Jira field
 *      (R2.5–2.8). Advancing is BLOCKED until every mandatory field is filled
 *      and every value satisfies its type (R2.10, R3) — the same rules the
 *      server enforces, mirrored client-side.
 *   3. Review — an Ollama-generated summary of the entry (R2.11); on
 *      `{available:false}` or any failure it falls back to showing the entered
 *      values and NEVER blocks submit (R2.12). Submit posts to
 *      `POST /api/requests` and navigates to the created request (R2.14).
 *
 * ── The horizontal stepper (UI spec: "Workflow Steps (Horizontal)") ──────────
 * Steps render as icon cards with connectors and a top-right number badge.
 * Sequence is enforced: future steps are greyed/locked, completed steps show a
 * green border + badge, and the current step pulses purple. You cannot jump
 * ahead; you move with Next/Previous, and Next on Step 2 is disabled until the
 * form is valid (R2.9–2.10).
 */
@Component({
  selector: 'app-new-workflow',
  standalone: true,
  imports: [ReactiveFormsModule, FormFieldComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './new-workflow.html',
  styleUrl: './new-workflow.scss',
})
export class NewWorkflow {
  private readonly workflow = inject(WorkflowService);
  private readonly router = inject(Router);

  /** The current step (1–3). */
  protected readonly step = signal<StepNumber>(1);

  // ── Step 1 state ─────────────────────────────────────────────────────────
  protected readonly teams = signal<OpenTeam[]>([]);
  protected readonly tasks = signal<ActiveTask[]>([]);
  protected readonly selectedTeamId = signal<number | null>(null);
  protected readonly selectedTaskId = signal<number | null>(null);
  protected readonly loadingTasks = signal(false);

  // ── Step 2 state ─────────────────────────────────────────────────────────
  protected readonly version = signal<CurrentVersion | null>(null);
  protected readonly loadingVersion = signal(false);
  /** The reactive form driving Step 2: one control per field, plus title/jira. */
  protected readonly form = signal<FormGroup | null>(null);
  /**
   * Mirror of `form.valid` as a signal. The FormGroup's own object identity
   * never changes as controls are edited, so a `computed` over the form signal
   * would not recompute; instead we subscribe to the form's `statusChanges` and
   * push the validity here so the Step 2 → Step 3 gate reacts live (R2.10).
   */
  protected readonly formValid = signal(false);

  // ── Step 3 state ─────────────────────────────────────────────────────────
  protected readonly summary = signal<ReviewSummary | null>(null);
  protected readonly loadingSummary = signal(false);

  /** A top-level error banner (load/submit failures). */
  protected readonly error = signal<string | null>(null);
  /** True while the submit POST is in flight. */
  protected readonly submitting = signal(false);

  constructor() {
    // A Clone action (Requests detail, R5.8) may hand us a pre-populated draft
    // via router state. When present, skip the empty Step 1 flow and open Step 2
    // pre-filled; otherwise start the ordinary "choose a team" flow (R2.3).
    const draft = this.readCloneDraft();
    if (draft) {
      this.startFromClone(draft);
      return;
    }
    this.workflow.listOpenTeams().subscribe({
      next: (teams) => this.teams.set(teams),
      error: () => this.error.set('Could not load teams. Please try again.'),
    });
  }

  /**
   * Read a {@link CloneDraft} handed over in router state by the Requests detail
   * Clone action (R5.8), or `null` for an ordinary New. `history.state` is the
   * durable place to read it (surviving the component's own construction timing),
   * and it is validated defensively so a malformed state can never crash the
   * workflow — it simply falls back to the empty flow.
   */
  private readCloneDraft(): CloneDraft | null {
    const state: unknown = typeof history !== 'undefined' && history.state ? history.state : null;
    if (!state || typeof state !== 'object') {
      return null;
    }
    const draft = (state as Record<string, unknown>)[CLONE_DRAFT_STATE_KEY];
    if (!draft || typeof draft !== 'object') {
      return null;
    }
    const candidate = draft as Partial<CloneDraft>;
    if (typeof candidate.taskId !== 'number' || !Array.isArray(candidate.fields)) {
      return null;
    }
    return candidate as CloneDraft;
  }

  /**
   * Open the workflow at Step 2 pre-populated from a {@link CloneDraft} (R5.8).
   * The New workflow always pins the task's CURRENT version on submit, so we
   * fetch the current version and seed each control from the draft's values,
   * matched by `taskFieldId`; title and Jira are seeded from the draft too. Any
   * fields no longer on the current version are dropped, and new mandatory
   * fields simply start empty and gate the advance as usual (R2.10).
   */
  private startFromClone(draft: CloneDraft): void {
    this.selectedTeamId.set(draft.teamId);
    this.selectedTaskId.set(draft.taskId);
    this.loadingVersion.set(true);
    this.error.set(null);
    this.workflow.getCurrentVersion(draft.taskId).subscribe({
      next: (version) => {
        this.version.set(version);
        const values = new Map<number, string>();
        for (const field of draft.fields) {
          values.set(field.taskFieldId, field.value ?? '');
        }
        const form = this.buildForm(version.fields, {
          title: draft.title,
          jira: draft.jiraNumber ?? '',
          values,
        });
        this.form.set(form);
        this.formValid.set(form.valid);
        form.statusChanges.subscribe(() => this.formValid.set(form.valid));
        this.loadingVersion.set(false);
        this.step.set(2);
      },
      error: () => {
        this.loadingVersion.set(false);
        this.error.set('Could not load the cloned request details. Please try again.');
      },
    });
  }

  // ── Stepper view model (UI spec) ───────────────────────────────────────────

  /** The three step nodes with their visual state for the horizontal stepper. */
  protected readonly steps = computed<StepNode[]>(() => {
    const current = this.step();
    const node = (number: StepNumber, label: string, icon: StepNode['icon']): StepNode => ({
      number,
      label,
      icon,
      state: number < current ? 'completed' : number === current ? 'running' : 'locked',
    });
    return [
      node(1, 'Team & Task', 'team'),
      node(2, 'Request Details', 'details'),
      node(3, 'Review', 'review'),
    ];
  });

  // ── Step 1: team → task cascade (R2.3) ─────────────────────────────────────

  /** Select a team: load its active tasks and clear any prior task choice. */
  protected onTeamChange(rawId: string): void {
    const teamId = rawId === '' ? null : Number(rawId);
    this.selectedTeamId.set(teamId);
    this.selectedTaskId.set(null);
    this.tasks.set([]);
    this.error.set(null);
    if (teamId === null) {
      return;
    }
    this.loadingTasks.set(true);
    this.workflow.listActiveTasks(teamId).subscribe({
      next: (tasks) => {
        this.tasks.set(tasks);
        this.loadingTasks.set(false);
      },
      error: () => {
        this.loadingTasks.set(false);
        this.error.set('Could not load tasks for that team. Please try again.');
      },
    });
  }

  /** Select a task within the chosen team. */
  protected onTaskChange(rawId: string): void {
    this.selectedTaskId.set(rawId === '' ? null : Number(rawId));
  }

  /** Step 1 → 2 is allowed only once both a team and a task are chosen (R2.4). */
  protected readonly canLeaveStep1 = computed(
    () => this.selectedTeamId() !== null && this.selectedTaskId() !== null,
  );

  // ── Step 2: typed fields + gating (R2.5–2.10, R3) ──────────────────────────

  /** The ordered fields to render on Step 2 (empty until the version loads). */
  protected readonly fields = computed<readonly FieldDefinition[]>(
    () => this.version()?.fields ?? [],
  );

  /**
   * Whether Step 2 → Step 3 is allowed (R2.10): the form must exist and be
   * valid — every mandatory field filled and every value type-correct, per the
   * shared {@link fieldValidator} mirrored from the server (R3).
   */
  protected readonly canLeaveStep2 = computed(() => this.form() !== null && this.formValid());

  /** The current per-field validation error to show under a field (R3, R3.6). */
  protected fieldError(field: FieldDefinition): string | null {
    const control = this.form()?.get(String(field.id));
    const err = control?.errors?.['fieldError'] as { message?: string } | undefined;
    return err?.message ?? null;
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  /** Advance to the next step, loading whatever the next step needs. */
  protected next(): void {
    const current = this.step();
    if (current === 1) {
      if (!this.canLeaveStep1()) {
        return;
      }
      this.loadVersion();
    } else if (current === 2) {
      if (!this.canLeaveStep2()) {
        // Reveal any outstanding errors by marking the form touched.
        this.form()?.markAllAsTouched();
        return;
      }
      this.loadSummary();
    }
  }

  /** Return to the previous step (R2.9, R2.13). */
  protected previous(): void {
    const current = this.step();
    if (current === 2) {
      this.step.set(1);
    } else if (current === 3) {
      this.step.set(2);
    }
  }

  /** Cancel: leave the workflow entirely (R2.4). */
  protected cancel(): void {
    void this.router.navigateByUrl('/');
  }

  /**
   * Load the chosen task's current version and build the Step 2 reactive form,
   * then advance. Each field control carries its {@link fieldValidator} so
   * `form.valid` gates the advance (R2.10). A mandatory title and an optional
   * Jira field (R2.8) are added alongside the task fields.
   */
  private loadVersion(): void {
    const taskId = this.selectedTaskId();
    if (taskId === null) {
      return;
    }
    this.loadingVersion.set(true);
    this.error.set(null);
    this.workflow.getCurrentVersion(taskId).subscribe({
      next: (version) => {
        this.version.set(version);
        const form = this.buildForm(version.fields);
        this.form.set(form);
        // Track validity live: the group's identity is stable, so mirror its
        // status into a signal the Step 2 gate reads (R2.10).
        this.formValid.set(form.valid);
        form.statusChanges.subscribe(() => this.formValid.set(form.valid));
        this.loadingVersion.set(false);
        this.step.set(2);
      },
      error: () => {
        this.loadingVersion.set(false);
        this.error.set('Could not load the task details. Please try again.');
      },
    });
  }

  /**
   * Build the Step 2 reactive form from the version's fields (R2.5). BOOLEAN
   * fields default to `false`; all others to `''`. Each control gets the shared
   * {@link fieldValidator} so mandatory/type gating runs client-side (R2.10).
   * `title` is required; `jira` is the always-present optional field (R2.8).
   */
  private buildForm(fields: readonly FieldDefinition[], seed?: FormSeed): FormGroup {
    const controls: Record<string, FormControl> = {
      title: new FormControl(seed?.title ?? '', {
        nonNullable: true,
        validators: [Validators.required],
      }),
      jira: new FormControl(seed?.jira ?? '', { nonNullable: true }),
    };
    for (const field of fields) {
      const seeded = seed?.values.get(Number(field.id));
      let initial: unknown;
      if (field.dataType === 'BOOLEAN') {
        initial = seeded === 'true';
      } else {
        initial = seeded ?? '';
      }
      controls[String(field.id)] = new FormControl(initial, {
        nonNullable: true,
        validators: [fieldValidator(field)],
      });
    }
    return new FormGroup(controls);
  }

  /** The entered values (label + string) for the summary and the fallback. */
  private enteredValues(): EnteredValue[] {
    const form = this.form();
    if (!form) {
      return [];
    }
    return this.fields().map((field) => ({
      taskFieldId: Number(field.id),
      name: field.label,
      value: stringifyValue(form.get(String(field.id))?.value),
    }));
  }

  /**
   * Request the Step 3 summary (R2.11) and advance. The backend returns
   * `{available:false}` on any Ollama failure (R2.12); a network error on the
   * call itself is treated the same way — a synthetic fallback that shows the
   * entered values — so submission is NEVER blocked.
   */
  private loadSummary(): void {
    const version = this.version();
    if (!version) {
      return;
    }
    const values = this.enteredValues();
    this.loadingSummary.set(true);
    this.summary.set(null);
    this.step.set(3);
    this.workflow.reviewSummary(version.versionId, values).subscribe({
      next: (summary) => {
        this.summary.set(summary);
        this.loadingSummary.set(false);
      },
      error: () => {
        // Even a transport failure must not block submit (R2.12): synthesise
        // the fallback so Step 3 shows the entered values.
        this.summary.set({
          available: false,
          taskVersionId: version.versionId,
          values: values.map((v) => ({ taskFieldId: v.taskFieldId, name: v.name, value: v.value })),
        });
        this.loadingSummary.set(false);
      },
    });
  }

  // ── Step 3: submit (R2.14) ─────────────────────────────────────────────────

  /**
   * Submit the request (R2.14). Posts the chosen task, the title, the optional
   * Jira number, and the entered field values to `POST /api/requests`; on
   * success navigates to the created request. The backend assigns the
   * reference, sets status NEW and pins the task version.
   */
  protected submit(): void {
    const taskId = this.selectedTaskId();
    const form = this.form();
    if (taskId === null || form === null || this.submitting()) {
      return;
    }
    this.submitting.set(true);
    this.error.set(null);

    const jira = stringifyValue(form.get('jira')?.value).trim();
    const body = {
      taskId,
      title: stringifyValue(form.get('title')?.value).trim(),
      jiraNumber: jira === '' ? null : jira,
      fieldValues: this.fields().map((field) => ({
        taskFieldId: Number(field.id),
        value: stringifyValue(form.get(String(field.id))?.value),
      })),
    };

    this.workflow.createRequest(body).subscribe({
      next: (created: CreatedRequest) => {
        this.submitting.set(false);
        void this.router.navigateByUrl(`/requests/${created.id}`);
      },
      error: () => {
        this.submitting.set(false);
        this.error.set('Could not submit the request. Please check your entries and try again.');
      },
    });
  }
}

/** Coerce a form control value to the string the backend expects (R2.14, R3). */
function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  return String(value);
}
