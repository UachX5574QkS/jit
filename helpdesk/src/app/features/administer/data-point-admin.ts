import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ApiError } from '../../core/http/api-error';
import { LocalDatePipe } from '../../shared/pipes/local-date.pipe';
import { DATA_TYPES, type DataType } from '../../shared/fields/field-types';
import {
  DataPointAdminService,
  type CreateDataPointRequest,
  type DataPointView,
} from './data-point-admin.service';

/** Human-facing label for each data type, shown in the picker and the table. */
export const DATA_TYPE_LABELS: Readonly<Record<DataType, string>> = {
  TEXT: 'Text',
  EMAIL: 'Email Address',
  DATE: 'Date',
  NUMERIC: 'Numeric',
  DATETIME: 'Date + Time',
  TIME: 'Time',
  BOOLEAN: 'Boolean',
  DROPDOWN: 'Dropdown',
  REGEXP: 'Regexp',
};

/** One option in the data-type picker. */
interface DataTypeOption {
  readonly value: DataType;
  readonly label: string;
}

/**
 * The Data Points management screen (task 14.1; design: "Administer — admin
 * tiles"; R14, R20.4).
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 * An administrator can:
 *   • LIST every data point — name, type, help text, options/pattern, and its
 *     active/retired state (R14.1);
 *   • CREATE a data point with a name, description, data type (from the shared
 *     nine-type set), default help text, and the TYPE-SPECIFIC extra: an options
 *     list for a DROPDOWN, or a pattern for a REGEXP (R14.2);
 *   • RETIRE a data point (R14.3), which the backend keeps operational for task
 *     versions already using it while blocking it from new task definitions
 *     (R14.4). Any retirement failure is surfaced gracefully as a row message.
 *
 * ── Type-specific create fields (R14.2) ──────────────────────────────────────
 * The options textarea is shown only for DROPDOWN and the pattern input only
 * for REGEXP, mirroring the backend's shape rules — a DROPDOWN needs a non-empty
 * option list and a REGEXP a non-empty pattern (both enforced server-side; the
 * `canCreate` gate mirrors them for UX). Options are entered one per line.
 *
 * ── AuthZ is server-side ─────────────────────────────────────────────────────
 * The route is admin-guarded for UX; every endpoint is enforced server-side
 * (R14/R13.1). A `FORBIDDEN` is shown as a friendly message, not a crash.
 */
@Component({
  selector: 'app-data-point-admin',
  standalone: true,
  imports: [FormsModule, RouterLink, LocalDatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './data-point-admin.html',
  styleUrl: './data-point-admin.scss',
})
export class DataPointAdmin {
  private readonly service = inject(DataPointAdminService);

  /** The data-type options for the picker (shared nine-type set, R3.1/R14.2). */
  protected readonly dataTypeOptions: readonly DataTypeOption[] = DATA_TYPES.map((value) => ({
    value,
    label: DATA_TYPE_LABELS[value],
  }));

  // ── Data ──────────────────────────────────────────────────────────────────
  protected readonly points = signal<DataPointView[]>([]);
  protected readonly loading = signal(false);
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Per-row message (e.g. a retirement failure), keyed by data point id. */
  protected readonly rowMessages = signal<Readonly<Record<number, string>>>({});

  protected readonly isEmpty = computed(
    () => this.loaded() && !this.loading() && !this.error() && this.points().length === 0,
  );

  // ── Create form ─────────────────────────────────────────────────────────────
  protected readonly newName = signal('');
  protected readonly newDescription = signal('');
  protected readonly newDataType = signal<DataType>('TEXT');
  protected readonly newHelpText = signal('');
  /** Raw DROPDOWN options textarea, one option per line. */
  protected readonly newOptionsRaw = signal('');
  /** Raw REGEXP pattern. */
  protected readonly newPattern = signal('');
  protected readonly creating = signal(false);
  protected readonly createError = signal<string | null>(null);

  /** True when the selected type needs a DROPDOWN option list (R14.2). */
  protected readonly needsOptions = computed(() => this.newDataType() === 'DROPDOWN');
  /** True when the selected type needs a REGEXP pattern (R14.2). */
  protected readonly needsPattern = computed(() => this.newDataType() === 'REGEXP');

  /** The parsed, non-empty options from the textarea (one per line). */
  private readonly parsedOptions = computed<string[]>(() =>
    this.newOptionsRaw()
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
  );

  /**
   * True when the create form is valid for the chosen type (R14.2), mirroring
   * the backend's shape rules: name required; DROPDOWN needs ≥1 option; REGEXP
   * needs a non-empty, compilable pattern.
   */
  protected readonly canCreate = computed(() => {
    if (this.creating() || this.newName().trim() === '') {
      return false;
    }
    if (this.needsOptions()) {
      return this.parsedOptions().length > 0;
    }
    if (this.needsPattern()) {
      const pattern = this.newPattern().trim();
      return pattern !== '' && isValidRegExp(pattern);
    }
    return true;
  });

  constructor() {
    this.reload();
  }

  /** Load the data points table (R14.1). */
  protected reload(): void {
    this.loading.set(true);
    this.error.set(null);
    this.service.listDataPoints().subscribe({
      next: (points) => {
        this.points.set(points);
        this.loading.set(false);
        this.loaded.set(true);
      },
      error: (err: unknown) => {
        this.loading.set(false);
        this.loaded.set(true);
        this.error.set(messageFor(err, 'Could not load data points.'));
      },
    });
  }

  /** Human label for a data type (table + form). */
  protected typeLabel(dataType: DataType): string {
    return DATA_TYPE_LABELS[dataType] ?? dataType;
  }

  /** The row-level message for a data point, if any. */
  protected rowMessage(point: DataPointView): string | null {
    return this.rowMessages()[point.id] ?? null;
  }

  private setRowMessage(id: number, message: string | null): void {
    this.rowMessages.update((prev) => {
      const next = { ...prev };
      if (message === null) {
        delete next[id];
      } else {
        next[id] = message;
      }
      return next;
    });
  }

  // ── Create (R14.2) ──────────────────────────────────────────────────────────
  protected createDataPoint(): void {
    if (!this.canCreate()) {
      return;
    }
    const dataType = this.newDataType();
    const description = this.newDescription().trim();
    const helpText = this.newHelpText().trim();
    const body: CreateDataPointRequest = {
      name: this.newName().trim(),
      dataType,
      description: description === '' ? null : description,
      defaultHelpText: helpText === '' ? null : helpText,
      regexpPattern: dataType === 'REGEXP' ? this.newPattern().trim() : null,
      defaultOptions: dataType === 'DROPDOWN' ? this.parsedOptions() : null,
    };

    this.creating.set(true);
    this.createError.set(null);
    this.service.createDataPoint(body).subscribe({
      next: (point) => {
        this.creating.set(false);
        this.points.update((prev) => [...prev, point]);
        this.resetForm();
      },
      error: (err: unknown) => {
        this.creating.set(false);
        this.createError.set(messageFor(err, 'Could not create the data point.'));
      },
    });
  }

  private resetForm(): void {
    this.newName.set('');
    this.newDescription.set('');
    this.newDataType.set('TEXT');
    this.newHelpText.set('');
    this.newOptionsRaw.set('');
    this.newPattern.set('');
  }

  // ── Retire (R14.3, R14.4) ────────────────────────────────────────────────────
  protected retireDataPoint(point: DataPointView): void {
    if (point.isRetired) {
      return;
    }
    this.setRowMessage(point.id, null);
    this.service.retireDataPoint(point.id).subscribe({
      next: (updated) => {
        this.points.update((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      },
      error: (err: unknown) => {
        this.setRowMessage(point.id, messageFor(err, 'Could not retire the data point.'));
      },
    });
  }

  protected trackByPointId(_index: number, point: DataPointView): number {
    return point.id;
  }
}

/** True iff `pattern` compiles as a JavaScript regular expression (R14.2). */
function isValidRegExp(pattern: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * A friendly message for a failed call. An {@link ApiError} carries the
 * backend's message; anything else falls back to the supplied default.
 */
function messageFor(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    if (err.code === 'FORBIDDEN') {
      return 'You are not permitted to manage data points.';
    }
    return err.message || fallback;
  }
  return fallback;
}
