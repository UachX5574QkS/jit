import { ApiError } from '../middleware/errors.js';

/**
 * Server-side field validation per data type and mandatory rules (design:
 * "Validation — per data type, incl. regexp/email/numeric and mandatory rules",
 * R3).
 *
 * ── Single source of truth for field validity ────────────────────────────────
 * The New workflow (task 10.2) and every request mutation that writes a
 * `request_field_value` (raiser updates R5.4/task 6.5, support updates
 * R7.1/task 7.2) validate a raw value against its field definition HERE, so the
 * type rules (R3.1–3.5) and the mandatory rule (R3.6) live behind one seam. The
 * schema owns the type set (the `data_point_type` enum, migration 0004) and the
 * per-field shape — `data_point.regexp_pattern`/`default_options` and the
 * task-level `task_field.options_override` (R3.4, R3.5, migration 0004). This
 * module owns the RULES for accepting or rejecting a value against that shape.
 * The client mirrors these rules for UX, but the server is the source of truth.
 *
 * ── The rules (R3) ───────────────────────────────────────────────────────────
 *   TEXT      — any text.
 *   EMAIL     — a well-formed email address (R3.2).
 *   NUMERIC   — a finite number only (R3.3).
 *   REGEXP    — matches the field's defined pattern; non-matching rejected (R3.4).
 *   DROPDOWN  — one of the field's option list: the task-level override where
 *               provided, otherwise the data point default list (R3.5).
 *   DATE      — an ISO calendar date `YYYY-MM-DD`.
 *   DATETIME  — Date+Time, ISO-8601.
 *   TIME      — `HH:MM` or `HH:MM:SS` (24-hour).
 *   BOOLEAN   — a boolean (or the strings `true`/`false`).
 *   Mandatory — an empty value on a mandatory field is rejected (R3.6).
 *
 * ── Empty / mandatory (R3.6) ─────────────────────────────────────────────────
 * A value is "empty" when it is `null`, `undefined`, or a blank/whitespace-only
 * string. On a MANDATORY field, empty is rejected with `MANDATORY_FIELD`. On an
 * OPTIONAL field, empty is accepted and short-circuits the type check (there is
 * nothing to type-check), so an optional untouched field never fails validation.
 *
 * ── Error shape ──────────────────────────────────────────────────────────────
 * Pure and side-effect free (unit-tested without a database). The guard
 * variants throw the shared {@link ApiError}: `MANDATORY_FIELD` (409) for an
 * empty mandatory field, `VALIDATION_FAILED` (400) for a type/format/option
 * mismatch. The full error-code catalogue is task 3.8; this reuses the existing
 * envelope with the two codes R3 calls for.
 */

/** The nine supported data point types (R3.1), matching the `data_point_type` enum. */
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
 * A field to validate against, decoupled from how it is sourced. Built from a
 * `task_field` joined to its `data_point`: the data point supplies `dataType`,
 * `regexpPattern` and the default option list; the task field supplies
 * `isMandatory` and any `optionsOverride` (R3.5, R16.3).
 */
export interface FieldDefinition {
  /** The field's data type (from `data_point.data_type`). */
  readonly dataType: DataType;
  /** Whether an empty value is rejected (from `task_field.is_mandatory`, R3.6). */
  readonly isMandatory: boolean;
  /**
   * The regular expression a REGEXP value must match (from
   * `data_point.regexp_pattern`, R3.4). Required for REGEXP fields.
   */
  readonly regexpPattern?: string | null;
  /**
   * The task-level dropdown option override (from `task_field.options_override`,
   * R3.5). Takes precedence over {@link defaultOptions} when present (non-null).
   */
  readonly optionsOverride?: readonly string[] | null;
  /**
   * The data point default dropdown option list (from
   * `data_point.default_options`, R3.5). Used when there is no override.
   */
  readonly defaultOptions?: readonly string[] | null;
  /** Optional label used only to make error messages/details clearer. */
  readonly name?: string;
}

/** The outcome of validating one value: valid, or invalid with a code + message. */
export type ValidationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      /** `MANDATORY_FIELD` for an empty mandatory field, else `VALIDATION_FAILED`. */
      readonly code: 'MANDATORY_FIELD' | 'VALIDATION_FAILED';
      readonly message: string;
    };

const VALID: ValidationResult = { valid: true };

/**
 * True iff `value` is "empty" for validation purposes (R3.6): `null`,
 * `undefined`, or a string that is blank or whitespace-only. Non-string,
 * non-nullish values (numbers, booleans) are never empty.
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

/**
 * A pragmatic, well-formed email check (R3.2): a single `@`, a non-empty local
 * part with no whitespace, and a domain with at least one dot and a 2+ char TLD.
 * Deliberately stricter than "contains an @" but not a full RFC 5322 parser —
 * it rejects the common malformed cases the UI must catch without false
 * negatives on ordinary addresses.
 */
const EMAIL_RE =
  /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)*\.[^\s@.]{2,}$/;

/** ISO calendar date `YYYY-MM-DD`. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `HH:MM` or `HH:MM:SS`, 24-hour. */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

/**
 * A decimal number literal: optional sign, integer/decimal digits, optional
 * fraction, optional decimal exponent. Deliberately excludes JS-only forms that
 * `Number()` would otherwise accept for a plain numeric field — hex (`0x10`),
 * binary (`0b10`), octal (`0o17`), and `Infinity` — so "numeric input" (R3.3)
 * means an ordinary decimal number a user would type.
 */
const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Whether `value` is a well-formed email address (R3.2). Non-strings are never
 * valid.
 */
export function isValidEmail(value: unknown): boolean {
  return typeof value === 'string' && EMAIL_RE.test(value.trim());
}

/**
 * Whether `value` is numeric (R3.3): a finite JS number, or a string that is an
 * ordinary decimal literal (optional sign, digits, optional fraction/exponent).
 * Blank strings, `NaN`/`Infinity`, trailing garbage, and JS-only hex/binary/
 * octal forms are all rejected — "numeric input" means a decimal number.
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
    // Restrict to a decimal literal (excludes hex/binary/octal/Infinity that
    // Number() would otherwise coerce), then confirm it is finite.
    return NUMERIC_RE.test(trimmed) && Number.isFinite(Number(trimmed));
  }
  return false;
}

/**
 * Whether `value` is a valid ISO calendar date `YYYY-MM-DD` (DATE fields). The
 * shape is checked with a regex and the calendar validity (real month/day) by
 * round-tripping through `Date`, so `2023-02-30` is rejected.
 */
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
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

/**
 * Whether `value` is a valid Date+Time (DATETIME fields): an ISO-8601 string
 * that `Date` can parse to a real instant. Requires both a date and a `T` time
 * component so a bare date is not accepted as a datetime.
 */
export function isValidDateTime(value: unknown): boolean {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  // Require a date part and a time part separated by T (ISO-8601).
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(trimmed)) {
    return false;
  }
  return !Number.isNaN(Date.parse(trimmed));
}

/** Whether `value` is a valid 24-hour time `HH:MM`/`HH:MM:SS` (TIME fields). */
export function isValidTime(value: unknown): boolean {
  return typeof value === 'string' && TIME_RE.test(value.trim());
}

/**
 * Whether `value` is a boolean (BOOLEAN fields): a JS boolean, or the strings
 * `"true"`/`"false"` (case-insensitive) that transport commonly delivers.
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

/**
 * The effective dropdown option list for a field (R3.5): the task-level
 * {@link FieldDefinition.optionsOverride} when present (non-null), otherwise the
 * data point {@link FieldDefinition.defaultOptions}. Returns `[]` when neither
 * is defined.
 */
export function resolveOptions(field: FieldDefinition): readonly string[] {
  if (field.optionsOverride != null) {
    return field.optionsOverride;
  }
  if (field.defaultOptions != null) {
    return field.defaultOptions;
  }
  return [];
}

/** Compile a REGEXP field's pattern, throwing VALIDATION_FAILED if it is missing/invalid. */
function compilePattern(field: FieldDefinition): RegExp {
  const pattern = field.regexpPattern;
  if (pattern == null || pattern === '') {
    throw new ApiError(
      400,
      'VALIDATION_FAILED',
      `${label(field)} is a Regexp field but has no pattern defined`,
      { name: field.name, dataType: field.dataType },
    );
  }
  try {
    return new RegExp(pattern);
  } catch {
    throw new ApiError(
      400,
      'VALIDATION_FAILED',
      `${label(field)} has an invalid regular expression pattern`,
      { name: field.name, dataType: field.dataType, pattern },
    );
  }
}

/** A human-facing label for a field in messages: its name, or the data type. */
function label(field: FieldDefinition): string {
  return field.name ?? `${field.dataType} field`;
}

/** Build a `VALIDATION_FAILED` result with a per-type message. */
function invalid(message: string): ValidationResult {
  return { valid: false, code: 'VALIDATION_FAILED', message };
}

/**
 * Validate a raw `value` against a field definition (R3), returning a structured
 * {@link ValidationResult}.
 *
 * Order of checks:
 *   1. Empty handling (R3.6): empty + mandatory → `MANDATORY_FIELD`; empty +
 *      optional → valid (nothing to type-check).
 *   2. Per-type check for the non-empty value (R3.1–3.5).
 *
 * A misconfigured REGEXP field (missing/invalid pattern) throws an
 * {@link ApiError} rather than returning a result, because that is a definition
 * error, not a user-input error.
 */
export function validateField(
  field: FieldDefinition,
  value: unknown,
): ValidationResult {
  if (isEmpty(value)) {
    if (field.isMandatory) {
      return {
        valid: false,
        code: 'MANDATORY_FIELD',
        message: `${label(field)} is required`,
      };
    }
    // Optional and empty: nothing to validate.
    return VALID;
  }

  switch (field.dataType) {
    case 'TEXT':
      return VALID;

    case 'EMAIL':
      return isValidEmail(value)
        ? VALID
        : invalid(`${label(field)} must be a valid email address`);

    case 'NUMERIC':
      return isNumeric(value)
        ? VALID
        : invalid(`${label(field)} must be numeric`);

    case 'DATE':
      return isValidDate(value)
        ? VALID
        : invalid(`${label(field)} must be a valid date (YYYY-MM-DD)`);

    case 'DATETIME':
      return isValidDateTime(value)
        ? VALID
        : invalid(`${label(field)} must be a valid date and time`);

    case 'TIME':
      return isValidTime(value)
        ? VALID
        : invalid(`${label(field)} must be a valid time (HH:MM)`);

    case 'BOOLEAN':
      return isBoolean(value)
        ? VALID
        : invalid(`${label(field)} must be true or false`);

    case 'DROPDOWN': {
      const options = resolveOptions(field);
      return options.includes(String(value))
        ? VALID
        : invalid(`${label(field)} must be one of the defined options`);
    }

    case 'REGEXP': {
      const re = compilePattern(field);
      return re.test(String(value))
        ? VALID
        : invalid(`${label(field)} does not match the required format`);
    }

    default: {
      // Exhaustiveness guard: a new data type must be handled above.
      const exhaustive: never = field.dataType;
      return invalid(`Unsupported data type: ${String(exhaustive)}`);
    }
  }
}

/**
 * Guard variant of {@link validateField}: returns normally when the value is
 * valid, otherwise throws an {@link ApiError} carrying the field name/type in
 * `details`. `MANDATORY_FIELD` → 409 (R3.6), `VALIDATION_FAILED` → 400 (R3).
 */
export function assertField(field: FieldDefinition, value: unknown): void {
  const result = validateField(field, value);
  if (result.valid) {
    return;
  }
  const status = result.code === 'MANDATORY_FIELD' ? 409 : 400;
  throw new ApiError(status, result.code, result.message, {
    name: field.name,
    dataType: field.dataType,
  });
}

/** One field definition paired with the raw value submitted for it. */
export interface FieldValue {
  readonly field: FieldDefinition;
  readonly value: unknown;
}

/** A single failure collected across a set of fields. */
export interface FieldError {
  /** The field's name if it had one, otherwise its data type. */
  readonly field: string;
  readonly code: 'MANDATORY_FIELD' | 'VALIDATION_FAILED';
  readonly message: string;
}

/**
 * Validate a whole set of fields at once, collecting EVERY failure rather than
 * stopping at the first. Returns the list of {@link FieldError}s (empty when all
 * pass) so the workflow (R2.10, task 10.2) can surface all problems together.
 */
export function validateFields(entries: readonly FieldValue[]): FieldError[] {
  const errors: FieldError[] = [];
  for (const { field, value } of entries) {
    const result = validateField(field, value);
    if (!result.valid) {
      errors.push({
        field: field.name ?? field.dataType,
        code: result.code,
        message: result.message,
      });
    }
  }
  return errors;
}

/**
 * Guard variant of {@link validateFields}: returns normally when every field
 * passes, otherwise throws a single {@link ApiError} (`VALIDATION_FAILED`, 400)
 * whose `details` carry the full list of per-field errors. If any failure is a
 * mandatory-empty one the code is `MANDATORY_FIELD` so the caller can react to
 * a required-field problem specifically (R3.6, R5.4).
 */
export function assertFields(entries: readonly FieldValue[]): void {
  const errors = validateFields(entries);
  if (errors.length === 0) {
    return;
  }
  const hasMandatory = errors.some((e) => e.code === 'MANDATORY_FIELD');
  const code = hasMandatory ? 'MANDATORY_FIELD' : 'VALIDATION_FAILED';
  const status = hasMandatory ? 409 : 400;
  throw new ApiError(status, code, 'One or more fields are invalid', {
    errors,
  });
}
