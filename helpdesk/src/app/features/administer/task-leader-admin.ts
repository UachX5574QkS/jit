import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiError } from '../../core/http/api-error';
import { CurrentUserService } from '../../core/auth/current-user.service';
import {
  TaskLeaderAdminService,
  type ActiveTask,
  type CreateTaskRequest,
  type CreateVersionRequest,
  type CurrentVersion,
  type LeadableTeam,
  type TaskFieldInput,
  type TaskView,
} from './task-leader-admin.service';

/**
 * An editable field row in the task form. Fields carried over from an existing
 * version keep their data point NAME and DATA TYPE for display, but those are
 * NOT editable (R16.3) — the leader may only reorder, toggle mandatory, and
 * override the description / help text / dropdown options. A brand-new field
 * (added on this screen) references a data point by id; its name/type resolve
 * server-side, so they show as pending.
 */
interface FieldRow {
  /** Client-only key for tracking rows in the template. */
  readonly key: number;
  /** The data point this field maps (immutable identity, R16.3). */
  dataPointId: number;
  /** Display-only name from the source version (blank for a newly added field). */
  readonly name: string;
  /** Display-only data type from the source version (blank for a new field). */
  readonly dataType: string;
  /** Whether this field references a data point already carried in the version. */
  readonly isExisting: boolean;
  isMandatory: boolean;
  descriptionOverride: string;
  helpTextOverride: string;
  /** Comma-free lines for a dropdown options override; empty → no override. */
  optionsOverride: string;
}

/**
 * The Team-Leader "Tasks" screen (task 14.2; design: "Administer — team-leader
 * tiles"; R16, R20.4).
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 * For a team the current user LEADS, a team leader can:
 *   • pick which of their teams to manage (from `teamsLed`, R16.1) and see its
 *     non-retired tasks (R16.5);
 *   • CREATE a task — name, support notes, and an ordered set of fields, each
 *     mapping a data point with optional description/help/dropdown overrides
 *     (R16.1–16.3);
 *   • create a NEW VERSION of a task (an "edit") — the current version prefills
 *     the form, and saving publishes a fresh version so requests on the prior
 *     version keep their layout (version pinning, R16.4);
 *   • RETIRE a task so it can't be chosen for new requests while staying with
 *     requests already raised against it (R16.6/R20.4).
 *
 * ── Override constraints are enforced in the UI (R16.3) ──────────────────────
 * A field's data point name and data type are shown read-only; only the
 * description, help text, dropdown options, order, and mandatory flag are
 * editable. The form never sends a name/dataType override, and the backend
 * rejects one anyway.
 *
 * ── AuthZ is server-side ─────────────────────────────────────────────────────
 * The route is team-leader-guarded for UX; the "leader-of-THIS-team" boundary
 * is enforced on every `/team-leader/tasks` endpoint (R16.1). A `FORBIDDEN` is
 * shown as a friendly message, never a crash.
 *
 * ── Adding a field without a leader-scoped data-point directory ──────────────
 * The data-point catalogue read is administrator-only, and the field contract
 * takes a numeric `dataPointId`. So a NEW field is added by data point id; the
 * server resolves and validates it (rejecting a retired/unknown id, R16.2).
 */
@Component({
  selector: 'app-task-leader-admin',
  standalone: true,
  imports: [FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './task-leader-admin.html',
  styleUrl: './task-leader-admin.scss',
})
export class TaskLeaderAdmin {
  private readonly service = inject(TaskLeaderAdminService);
  private readonly currentUser = inject(CurrentUserService);

  // ── Team picker ─────────────────────────────────────────────────────────────
  protected readonly ledTeamIds = computed<readonly number[]>(
    () => this.currentUser.user()?.teamsLed ?? [],
  );
  protected readonly leadableTeams = signal<LeadableTeam[]>([]);
  protected readonly selectedTeamId = signal<number | null>(null);

  // ── Tasks list ──────────────────────────────────────────────────────────────
  protected readonly tasks = signal<ActiveTask[]>([]);
  protected readonly loadingTasks = signal(false);
  protected readonly listError = signal<string | null>(null);
  /** Per-task row message (e.g. a retire failure), keyed by task id. */
  protected readonly rowMessages = signal<Readonly<Record<number, string>>>({});

  // ── Editor ────────────────────────────────────────────────────────────────
  /** `null` = no editor open; `'create'` = new task; a number = editing that task. */
  protected readonly editorMode = signal<'create' | number | null>(null);
  protected readonly editorLoading = signal(false);
  protected readonly formName = signal('');
  protected readonly formSupportNotes = signal('');
  protected readonly fields = signal<FieldRow[]>([]);
  protected readonly newDataPointId = signal('');
  protected readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);
  /** The version number just published, shown to confirm the pinning semantics. */
  protected readonly publishedVersionNo = signal<number | null>(null);

  private nextKey = 1;

  protected readonly isEditing = computed(() => typeof this.editorMode() === 'number');
  protected readonly editorOpen = computed(() => this.editorMode() !== null);

  /** The task being edited (for its title/version note), when in edit mode. */
  protected readonly editingTask = computed<ActiveTask | null>(() => {
    const mode = this.editorMode();
    if (typeof mode !== 'number') {
      return null;
    }
    return this.tasks().find((t) => t.id === mode) ?? null;
  });

  protected readonly canSave = computed(
    () => this.formName().trim() !== '' && !this.saving() && !this.editorLoading(),
  );

  protected readonly canAddField = computed(() => {
    const id = parsePositiveInt(this.newDataPointId());
    return id !== null && !this.fields().some((f) => f.dataPointId === id);
  });

  constructor() {
    this.loadLeadableTeams();
  }

  private loadLeadableTeams(): void {
    const ledIds = this.ledTeamIds();
    this.service.listOpenTeams().subscribe({
      next: (teams) => this.leadableTeams.set(mergeLeadable(ledIds, teams)),
      error: () => this.leadableTeams.set(ledIds.map((id) => ({ id, title: `Team #${id}` }))),
    });
    if (ledIds.length === 1) {
      this.selectTeam(ledIds[0]);
    }
  }

  protected teamLabel(teamId: number): string {
    return this.leadableTeams().find((t) => t.id === teamId)?.title ?? `Team #${teamId}`;
  }

  protected onSelectTeam(raw: string): void {
    const id = parsePositiveInt(raw);
    if (id === null) {
      this.selectedTeamId.set(null);
      this.tasks.set([]);
      return;
    }
    this.selectTeam(id);
  }

  /** Load the selected team's non-retired tasks (R16.5). */
  protected selectTeam(teamId: number): void {
    this.selectedTeamId.set(teamId);
    this.closeEditor();
    this.tasks.set([]);
    this.listError.set(null);
    this.rowMessages.set({});
    this.loadingTasks.set(true);
    this.service.listActiveTasks(teamId).subscribe({
      next: (tasks) => {
        this.loadingTasks.set(false);
        this.tasks.set([...tasks].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id));
      },
      error: (err: unknown) => {
        this.loadingTasks.set(false);
        this.listError.set(messageFor(err, 'Could not load tasks for this team.'));
      },
    });
  }

  // ── Editor lifecycle ─────────────────────────────────────────────────────
  /** Open a blank form for a brand-new task (R16.1). */
  protected startCreate(): void {
    this.editorMode.set('create');
    this.formName.set('');
    this.formSupportNotes.set('');
    this.fields.set([]);
    this.newDataPointId.set('');
    this.formError.set(null);
    this.publishedVersionNo.set(null);
    this.editorLoading.set(false);
  }

  /** Open the form for editing a task, prefilled from its current version (R16.4/16.5). */
  protected startEdit(task: ActiveTask): void {
    this.editorMode.set(task.id);
    this.formError.set(null);
    this.publishedVersionNo.set(null);
    this.newDataPointId.set('');
    this.editorLoading.set(true);
    this.formName.set(task.name);
    this.formSupportNotes.set('');
    this.fields.set([]);
    this.service.getCurrentVersion(task.id).subscribe({
      next: (version) => {
        this.editorLoading.set(false);
        this.applyVersionToForm(version);
      },
      error: (err: unknown) => {
        this.editorLoading.set(false);
        this.formError.set(messageFor(err, 'Could not load the current task version.'));
      },
    });
  }

  /** Prefill the form from a loaded current version, preserving order (R16.5). */
  private applyVersionToForm(version: CurrentVersion): void {
    this.formName.set(version.taskName);
    this.formSupportNotes.set(version.supportNotes ?? '');
    const rows = [...version.fields]
      .sort((a, b) => a.fieldOrder - b.fieldOrder)
      .map<FieldRow>((f) => ({
        key: this.nextKey++,
        dataPointId: f.dataPointId,
        name: f.name,
        dataType: f.dataType,
        isExisting: true,
        isMandatory: f.isMandatory,
        // The current-version read already folds overrides into the effective
        // text; prefill with those so an unedited save preserves them.
        descriptionOverride: f.description ?? '',
        helpTextOverride: f.helpText ?? '',
        optionsOverride: (f.options ?? []).join('\n'),
      }));
    this.fields.set(rows);
  }

  protected closeEditor(): void {
    this.editorMode.set(null);
    this.formError.set(null);
    this.publishedVersionNo.set(null);
  }

  // ── Field row editing ───────────────────────────────────────────────────
  /** Add a new field referencing the entered data point id (R16.2). */
  protected addField(): void {
    const id = parsePositiveInt(this.newDataPointId());
    if (id === null || this.fields().some((f) => f.dataPointId === id)) {
      return;
    }
    this.fields.update((prev) => [
      ...prev,
      {
        key: this.nextKey++,
        dataPointId: id,
        name: '',
        dataType: '',
        isExisting: false,
        isMandatory: false,
        descriptionOverride: '',
        helpTextOverride: '',
        optionsOverride: '',
      },
    ]);
    this.newDataPointId.set('');
  }

  protected removeField(key: number): void {
    this.fields.update((prev) => prev.filter((f) => f.key !== key));
  }

  /** Move a field up/down to change its order (R16.2). */
  protected moveField(key: number, direction: -1 | 1): void {
    this.fields.update((prev) => {
      const index = prev.findIndex((f) => f.key === key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= prev.length) {
        return prev;
      }
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  protected updateFieldMandatory(key: number, value: boolean): void {
    this.patchField(key, (f) => ({ ...f, isMandatory: value }));
  }

  protected updateFieldDescription(key: number, value: string): void {
    this.patchField(key, (f) => ({ ...f, descriptionOverride: value }));
  }

  protected updateFieldHelp(key: number, value: string): void {
    this.patchField(key, (f) => ({ ...f, helpTextOverride: value }));
  }

  protected updateFieldOptions(key: number, value: string): void {
    this.patchField(key, (f) => ({ ...f, optionsOverride: value }));
  }

  private patchField(key: number, fn: (f: FieldRow) => FieldRow): void {
    this.fields.update((prev) => prev.map((f) => (f.key === key ? fn(f) : f)));
  }

  // ── Save ──────────────────────────────────────────────────────────────────
  protected save(): void {
    if (!this.canSave()) {
      return;
    }
    const mode = this.editorMode();
    if (mode === null) {
      return;
    }
    const fieldInputs = this.buildFieldInputs();
    const supportNotes = this.formSupportNotes().trim();
    const name = this.formName().trim();

    this.saving.set(true);
    this.formError.set(null);
    this.publishedVersionNo.set(null);

    if (mode === 'create') {
      const teamId = this.selectedTeamId();
      if (teamId === null) {
        this.saving.set(false);
        return;
      }
      const body: CreateTaskRequest = {
        teamId,
        name,
        supportNotes: supportNotes === '' ? null : supportNotes,
        fields: fieldInputs,
      };
      this.service.createTask(body).subscribe({
        next: (task) => this.onSaved(task, true),
        error: (err: unknown) => this.onSaveError(err),
      });
    } else {
      const body: CreateVersionRequest = {
        name,
        supportNotes: supportNotes === '' ? null : supportNotes,
        fields: fieldInputs,
      };
      this.service.createVersion(mode, body).subscribe({
        next: (task) => this.onSaved(task, false),
        error: (err: unknown) => this.onSaveError(err),
      });
    }
  }

  /** Translate the editable rows into the API field inputs (R16.2, R16.3). */
  private buildFieldInputs(): TaskFieldInput[] {
    return this.fields().map((f, index) => {
      const options = f.optionsOverride
        .split('\n')
        .map((o) => o.trim())
        .filter((o) => o !== '');
      const description = f.descriptionOverride.trim();
      const help = f.helpTextOverride.trim();
      return {
        dataPointId: f.dataPointId,
        // Persist the visible order (top row first) as a 0-based index.
        fieldOrder: index,
        isMandatory: f.isMandatory,
        descriptionOverride: description === '' ? null : description,
        helpTextOverride: help === '' ? null : help,
        optionsOverride: options.length > 0 ? options : null,
      } satisfies TaskFieldInput;
    });
  }

  private onSaved(task: TaskView, wasCreate: boolean): void {
    this.saving.set(false);
    this.publishedVersionNo.set(task.currentVersion.versionNo);
    // Refresh the task list so a newly created task appears and a rename shows.
    const teamId = this.selectedTeamId();
    if (teamId !== null) {
      this.service.listActiveTasks(teamId).subscribe({
        next: (tasks) =>
          this.tasks.set(
            [...tasks].sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id),
          ),
      });
    }
    if (wasCreate) {
      // Keep the editor open in edit mode on the new task so the leader sees it saved.
      this.editorMode.set(task.id);
    }
  }

  private onSaveError(err: unknown): void {
    this.saving.set(false);
    this.formError.set(messageFor(err, 'Could not save the task.'));
  }

  // ── Retire (R16.6, R20.4) ──────────────────────────────────────────────────
  protected retireTask(task: ActiveTask): void {
    this.setRowMessage(task.id, null);
    this.service.retireTask(task.id).subscribe({
      next: () => {
        // Retired tasks drop out of the active list; remove the row and close
        // the editor if it was open on this task.
        this.tasks.update((prev) => prev.filter((t) => t.id !== task.id));
        if (this.editorMode() === task.id) {
          this.closeEditor();
        }
      },
      error: (err: unknown) =>
        this.setRowMessage(task.id, messageFor(err, 'Could not retire the task.')),
    });
  }

  protected rowMessage(task: ActiveTask): string | null {
    return this.rowMessages()[task.id] ?? null;
  }

  private setRowMessage(taskId: number, message: string | null): void {
    this.rowMessages.update((prev) => {
      const next = { ...prev };
      if (message === null) {
        delete next[taskId];
      } else {
        next[taskId] = message;
      }
      return next;
    });
  }

  protected trackByTaskId(_index: number, task: ActiveTask): number {
    return task.id;
  }

  protected trackByFieldKey(_index: number, field: FieldRow): number {
    return field.key;
  }
}

/** Parse a positive integer from a string/number, or `null` when malformed. */
function parsePositiveInt(raw: string | number): number | null {
  const value = typeof raw === 'number' ? String(raw) : raw.trim();
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Build the leadable-team option list (title from open teams, else id-based). */
function mergeLeadable(ledIds: readonly number[], openTeams: LeadableTeam[]): LeadableTeam[] {
  const titleById = new Map(openTeams.map((t) => [t.id, t.title]));
  return [...ledIds]
    .map((id) => ({ id, title: titleById.get(id) ?? `Team #${id}` }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id - b.id);
}

/** A friendly message for a failed call; `FORBIDDEN` worded for this screen. */
function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === 'FORBIDDEN') {
      return 'You can only manage tasks for a team you lead.';
    }
    return err.message || fallback;
  }
  return fallback;
}
