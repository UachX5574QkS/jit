import {
  ChangeDetectionStrategy,
  Component,
  computed,
  forwardRef,
  input,
  signal,
} from '@angular/core';
import { NG_VALUE_ACCESSOR, type ControlValueAccessor } from '@angular/forms';
import {
  resolveOptions,
  type DataType,
  type FieldDefinition,
} from './field-types';

/** Stable counter so each field instance can mint unique element ids for a11y. */
let uid = 0;

/**
 * A single shared, reusable form field that honours a data point's data type
 * (design: "shared/ UI … purple form styling"; R2.5–2.8, R3, R16.3).
 *
 * ── What it renders ──────────────────────────────────────────────────────────
 * Given a {@link FieldDefinition}, it renders the label (uppercase/purple per
 * the UI spec) with a red `*` when mandatory, the type-appropriate control, an
 * optional "?" help affordance, and any client-side validation error. One
 * component covers every data type (R3.1) so screens never re-implement a field:
 *
 *   • TEXT              → single-line text input.
 *   • EMAIL             → email input.
 *   • NUMERIC           → numeric input (`inputmode="decimal"`).
 *   • DATE              → native date PICKER (R2.7).
 *   • DATETIME          → native datetime-local PICKER (R2.7).
 *   • TIME              → native time picker.
 *   • BOOLEAN           → checkbox (true/false).
 *   • DROPDOWN          → `<select>` of the resolved option list (R3.5).
 *   • REGEXP            → text input (pattern enforced by the validator, R3.4).
 *
 * ── ControlValueAccessor ─────────────────────────────────────────────────────
 * It implements {@link ControlValueAccessor} so it drops straight into Angular
 * reactive forms with `formControlName` / `[formControl]`. The New workflow
 * (task 10.2) attaches {@link fieldValidator} to the control and reads
 * `form.valid` to gate Step 2 → Step 3 (R2.10); this component only OWNS the
 * value and the presentation, not the validation authority (the server is the
 * source of truth — see field-types.ts).
 *
 * ── The "?" help affordance (R2.6) ───────────────────────────────────────────
 * When the field has help text (default or task override, R16.3) or a
 * description, a "?" button is shown next to the label. Toggling it reveals a
 * small panel with the text; it is wired with `aria-expanded`/`aria-controls`
 * so it is operable and announced. When there is no help text/description, no
 * "?" is offered.
 *
 * ── Error display (R3, R3.6) ─────────────────────────────────────────────────
 * The component does not decide validity — it reads the bound control's errors.
 * When the host control carries `{ fieldError: { message } }` from
 * {@link fieldValidator} AND the control is touched/dirty, the message (identical
 * to the server's wording) is shown under the field and the control is marked
 * `aria-invalid`.
 */
@Component({
  selector: 'app-form-field',
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './form-field.html',
  styleUrl: './form-field.scss',
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => FormFieldComponent),
      multi: true,
    },
  ],
})
export class FormFieldComponent implements ControlValueAccessor {
  /** The field to render and bind. */
  readonly field = input.required<FieldDefinition>();

  /**
   * The validation error to display, supplied by the host (typically the bound
   * control's `fieldError`). When set AND the field has been interacted with,
   * the message is shown. Kept as an input so a screen can drive display from
   * its reactive-form control state without this component reaching into it.
   */
  readonly errorMessage = input<string | null>(null);

  /** Unique base id for the control/label/help/error elements (a11y wiring). */
  protected readonly uid = `ff-${++uid}`;

  /** The current value held by the CVA. */
  protected readonly value = signal<unknown>(null);
  /** Whether the control is disabled (driven by the forms API). */
  protected readonly disabled = signal(false);
  /** Whether the "?" help panel is open. */
  protected readonly helpOpen = signal(false);
  /** Set once the user blurs the field, so errors only show after interaction. */
  protected readonly touched = signal(false);

  /** The resolved dropdown options (R3.5). */
  protected readonly options = computed(() => resolveOptions(this.field()));

  /** Whether a "?" affordance should be offered (help text or description, R2.6). */
  protected readonly hasHelp = computed(() => {
    const f = this.field();
    return nonEmpty(f.helpText) || nonEmpty(f.description);
  });

  /** The text revealed by the "?" affordance: help text, then description (R2.6). */
  protected readonly helpText = computed(() => {
    const f = this.field();
    return (nonEmpty(f.helpText) ? f.helpText : f.description) ?? '';
  });

  /** The boolean view of the value for the BOOLEAN checkbox. */
  protected readonly checked = computed(() => this.value() === true || this.value() === 'true');

  /** The string view of the value for text-like inputs / selects / pickers. */
  protected readonly stringValue = computed(() => {
    const v = this.value();
    return v === null || v === undefined ? '' : String(v);
  });

  // ── ControlValueAccessor plumbing ──────────────────────────────────────────

  private onChange: (value: unknown) => void = () => {};
  private onTouched: () => void = () => {};

  writeValue(value: unknown): void {
    this.value.set(value ?? null);
  }

  registerOnChange(fn: (value: unknown) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  // ── Template event handlers ────────────────────────────────────────────────

  /** Handle input/change from a text-like control, select, or picker. */
  protected onValueInput(raw: string): void {
    this.value.set(raw);
    this.onChange(raw);
  }

  /** Handle the BOOLEAN checkbox toggle: stores a real boolean. */
  protected onBooleanToggle(isChecked: boolean): void {
    this.value.set(isChecked);
    this.onChange(isChecked);
  }

  /** Mark the field touched on blur so errors surface only after interaction. */
  protected onBlur(): void {
    this.touched.set(true);
    this.onTouched();
  }

  /** Toggle the "?" help panel (R2.6). */
  protected toggleHelp(): void {
    this.helpOpen.update((open) => !open);
  }

  /** The HTML `type` for a text-like `<input>` given the data type. */
  protected inputType(dataType: DataType): string {
    switch (dataType) {
      case 'EMAIL':
        return 'email';
      case 'NUMERIC':
        return 'number';
      case 'DATE':
        return 'date';
      case 'DATETIME':
        return 'datetime-local';
      case 'TIME':
        return 'time';
      default:
        return 'text';
    }
  }
}

/** True iff `value` is a non-blank string. */
function nonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}
