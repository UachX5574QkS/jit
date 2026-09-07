/**
 * Server-side field validation per data type and mandatory rules (design:
 * "Validation — per data type, incl. regexp/email/numeric and mandatory rules",
 * R3).
 *
 * Feature code that accepts request field values — the New workflow (task 10.2)
 * and every mutation writing a `request_field_value` (raiser updates R5.4/task
 * 6.5, support updates R7.1/task 7.2) — imports the {@link FieldDefinition}
 * shape and the validators/guards from here and nowhere else, so the type rules
 * (R3.1–3.5) and the mandatory rule (R3.6) live behind a single seam. Single
 * values go through {@link validateField}/{@link assertField}; a whole form goes
 * through {@link validateFields}/{@link assertFields}, which collect every
 * failure. Guard variants throw the shared `ApiError` with `MANDATORY_FIELD` /
 * `VALIDATION_FAILED`.
 */
export type {
  DataType,
  FieldDefinition,
  ValidationResult,
  FieldValue,
  FieldError,
} from './validation.js';
export {
  DATA_TYPES,
  isDataType,
  isEmpty,
  isValidEmail,
  isNumeric,
  isValidDate,
  isValidDateTime,
  isValidTime,
  isBoolean,
  resolveOptions,
  validateField,
  assertField,
  validateFields,
  assertFields,
} from './validation.js';
