/**
 * The frontend view of a task field and the client-side mirror of the backend's
 * field-validation rules (design: "Validation — enforced server-side (source of
 * truth) and mirrored client-side for UX", R3; workflow R2.5–2.8, R2.10).
 *
 * ── Why mirror the server here ───────────────────────────────────────────────
 * The server (`backend/src/validation/validation.ts`) is the single source of
 * truth: it accepts or rejects a value per data type (R3.1–3.5) and rejects an
 * empty mandatory field (R3.6). The New workflow (task 10.2) must block
 * advancing from Step 2 to Step 3 until every mandatory field is filled and
 * every value is valid (R2.10) — that gate has to run in the browser for a
 * usable form. So this module re-implements the SAME rules with the SAME
 * messages the server produces, exposed as Angular reactive-form validators the
 * shared {@link FormFieldComponent} can attach. The server still re-validates on
 * submit; this is UX, not the authority.
 *
 * The regexes, the "empty" definition, and the per-type messages here are kept
 * byte-for-byte aligned with the backend module so a value that passes client
 * validation also passes server validation (and the surfaced error text
 * matches, R3.6/R3 error codes MANDATORY_FIELD / VALIDATION_FAILED, task 3.7/3.8).
 */

import type { AbstractControl, ValidationErrors, ValidatorFn } from '@angular/forms';

/** The nine supported data point types (R3.1), matching the backend `DataType`. */
export const DATA_TYPES = [
  'TEXT',
  'EMAIL',
  'DATE',
  'NUMERIC',
  'DATETIME',
  'TIME',
  'BOOLEAN',
  'DROPDOWN',
  'REGEXP',
] as const;

/** A data point data type. Union of the nine values in {@link DATA_TYPES}. */
export type DataType = (typeof DATA_TYPES)[number];

const DATA_TYPE_SET: ReadonlySet<string> = new Set(DATA_TYPES);

/** True iff `value` is one of the nine known data types. */
export function isDataType(value: unknown): value is DataType {
  return typeof value === 'string' && DATA_TYPE_SET.has(value);
}

/**
 * Coerce a backend data-type string into a {@link DataType}, defaulting to TEXT
 * for anything unknown so an unexpected backend type can never break rendering.
 * Shared by every service that maps a field DTO into a {@link FieldDefinition}
 * (workflow current-version, request detail, clone draft).
 */
export function toDataType(raw: string): DataType {
  return isDataType(raw) ? raw : 'TEXT';
}

/**
 * A single field to render and validate, as delivered by
 * `GET /api/tasks/{id}/current-version` (design: workflow support; R2.5–2.8,
 * R3, R16.2–16.3).
 *
 * The effective description/help text already fold in any task-level override
 * (R16.3): the workflow resolves `help_text_override ?? default_help_text` and
 * `description_override ?? description` before handing the field to the UI, so
 * this shape carries the FINAL text to show.
 */
export interface FieldDefinition {
  /** Stable id of the task field (used as the reactive-form control key). */
  readonly id: string | number;
  /** The field's data type (R3.1). */
  readonly dataType: DataType;
  /** Human-facing label, shown uppercase/purple with a red `*` when mandatory. */
  readonly label: string;
  /** Whether an empty value is rejected (R3.6). */
  readonly isMandatory: boolean;
  /**
   * The effective help text (default, or the task-level override) shown behind
   * the "?" affordance (R2.6, R16.3). When absent/empty, no "?" is offered.
   */
  readonly helpText?: string | null;
  /** Optional longer description; also surfaced by the "?" affordance (R2.6). */
  readonly description?: string | null;
  /** The regular expression a REGEXP value must match (R3.4). */
  readonly regexpPattern?: string | null;
  /**
   * The effective dropdown option list (R3.5): the task-level override where
   * provided, otherwise the data point default list — already resolved by the
   * workflow, so this is the list to render.
   */
  readonly options?: readonly string[] | null;
}

// ── Rules mirrored from the backend (keep byte-for-byte aligned) ──────────────

/**
 * A pragmatic, well-formed email check (R3.2), identical to the backend
 * `EMAIL_RE`: a single `@`, a non-empty local part with no whitespace, and a
 * domain with at least one dot and a 2+ char TLD.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[^\s@.]{2,}$/;

/** ISO calendar date `YYYY-MM-DD`. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `HH:MM` or `HH:MM:SS`, 24-hour. */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

/**
 * A decimal number literal (R3.3): optional sign, integer/decimal digits,
 * optional fraction, optional decimal exponent — excludes JS-only hex/binary/
 * octal/Infinity, matching the backend `NUMERIC_RE`.
 */
const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * True iff `value` is "empty" for validation purposes (R3.6), matching the
 * backend `isEmpty`: `null`, `undefined`, or a blank/whitespace-only string.
 * `false` is a real BOOLEAN value and is NOT empty.
 */
export function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value === 'string') {
    return value.trim() === '';
  }
  return false;
}

/** Whether `value` is a well-formed email address (R3.2). */
export function isValidEmail(value: unknown): boolean {
  return typeof value === 'string' && EMAIL_RE.test(value.trim());
}

/**
 * Whether `value` is numeric (R3.3): a finite number, or a string that is an
 * ordinary decimal literal. Matches the backend `isNumeric`.
 */
export function isNumeric(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return false;
    }
    return NUMERIC_RE.test(trimmed) && Number.isFinite(Number(trimmed));
  }
  return false;
}

/** Whether `value` is a valid ISO calendar date `YYYY-MM-DD` (R3, DATE). */
export function isValidDate(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (!DATE_RE.test(trimmed)) {
    return false;
  }
  const [y, m, d] = trimmed.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** Whether `value` is a valid ISO-8601 Date+Time (R3, DATETIME). */
export function isValidDateTime(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(trimmed)) {
    return false;
  }
  return !Number.isNaN(Date.parse(trimmed));
}

/** Whether `value` is a valid 24-hour time `HH:MM`/`HH:MM:SS` (R3, TIME). */
export function isValidTime(value: unknown): boolean {
  return typeof value === 'string' && TIME_RE.test(value.trim());
}

/**
 * Whether `value` is a boolean (R3, BOOLEAN): a JS boolean or the strings
 * `"true"`/`"false"`. Matches the backend `isBoolean`.
 */
export function isBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    return lower === 'true' || lower === 'false';
  }
  return false;
}

/** The effective dropdown option list for a field (R3.5): options or `[]`. */
export function resolveOptions(field: FieldDefinition): readonly string[] {
  return field.options ?? [];
}

/**
 * The per-type validation message for a NON-EMPTY invalid value, worded exactly
 * as the backend produces it so the client and server surface the same text
 * (R3). `label` is the field's human-facing name.
 */
export function typeErrorMessage(field: FieldDefinition): string {
  const label = field.label;
  switch (field.dataType) {
    case 'EMAIL':
      return `${label} must be a valid email address`;
    case 'NUMERIC':
      return `${label} must be numeric`;
    case 'DATE':
      return `${label} must be a valid date (YYYY-MM-DD)`;
    case 'DATETIME':
      return `${label} must be a valid date and time`;
    case 'TIME':
      return `${label} must be a valid time (HH:MM)`;
    case 'BOOLEAN':
      return `${label} must be true or false`;
    case 'DROPDOWN':
      return `${label} must be one of the defined options`;
    case 'REGEXP':
      return `${label} does not match the required format`;
    case 'TEXT':
    default:
      return `${label} is invalid`;
  }
}

/** The mandatory-empty message, worded exactly as the backend produces it (R3.6). */
export function mandatoryErrorMessage(field: FieldDefinition): string {
  return `${field.label} is required`;
}

/**
 * The outcome of validating one value against a field (client mirror of the
 * backend `ValidationResult`): valid, or invalid with a code + message.
 */
export type FieldValidationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      /** `MANDATORY_FIELD` for an empty mandatory field, else `VALIDATION_FAILED` (R3, R3.6). */
      readonly code: 'MANDATORY_FIELD' | 'VALIDATION_FAILED';
      readonly message: string;
    };

const VALID: FieldValidationResult = { valid: true };

/**
 * Validate a raw `value` against a field, returning the same structured result
 * and messages the backend would (design: "Validation … mirrored client-side",
 * R3). Order matches the server:
 *   1. empty + mandatory → MANDATORY_FIELD; empty + optional → valid (R3.6);
 *   2. per-type check (R3.1–3.5).
 *
 * A REGEXP field with a missing/invalid pattern is treated as VALIDATION_FAILED
 * (the value cannot be accepted client-side); the server enforces the same
 * rejection.
 */
export function validateFieldValue(field: FieldDefinition, value: unknown): FieldValidationResult {
  if (isEmpty(value)) {
    return field.isMandatory
      ? { valid: false, code: 'MANDATORY_FIELD', message: mandatoryErrorMessage(field) }
      : VALID;
  }

  const invalid: FieldValidationResult = {
    valid: false,
    code: 'VALIDATION_FAILED',
    message: typeErrorMessage(field),
  };

  switch (field.dataType) {
    case 'TEXT':
      return VALID;
    case 'EMAIL':
      return isValidEmail(value) ? VALID : invalid;
    case 'NUMERIC':
      return isNumeric(value) ? VALID : invalid;
    case 'DATE':
      return isValidDate(value) ? VALID : invalid;
    case 'DATETIME':
      return isValidDateTime(value) ? VALID : invalid;
    case 'TIME':
      return isValidTime(value) ? VALID : invalid;
    case 'BOOLEAN':
      return isBoolean(value) ? VALID : invalid;
    case 'DROPDOWN':
      return resolveOptions(field).includes(String(value)) ? VALID : invalid;
    case 'REGEXP':
      return matchesPattern(field, value) ? VALID : invalid;
    default:
      return invalid;
  }
}

/** True iff a REGEXP field has a usable pattern and `value` matches it (R3.4). */
function matchesPattern(field: FieldDefinition, value: unknown): boolean {
  const pattern = field.regexpPattern;
  if (pattern == null || pattern === '') {
    return false;
  }
  try {
    return new RegExp(pattern).test(String(value));
  } catch {
    return false;
  }
}

/**
 * An Angular reactive-form {@link ValidatorFn} for a field. On failure it
 * returns `{ fieldError: { code, message } }` so the shared component can render
 * the same message the server would (R3, R3.6). Returns `null` when valid.
 *
 * The workflow attaches this to each control and uses `form.valid` to gate the
 * Step 2 → Step 3 advance (R2.10).
 */
export function fieldValidator(field: FieldDefinition): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const result = validateFieldValue(field, control.value);
    if (result.valid) {
      return null;
    }
    return { fieldError: { code: result.code, message: result.message } };
  };
}
