import { one, many, withTransaction, type Queryable } from '../db/query.js';
import { AuditWriter, type FieldSnapshot } from '../audit/index.js';
import {
  assertFields,
  resolveOptions,
  type DataType,
  type FieldDefinition,
  type FieldValue,
} from '../validation/index.js';

/**
 * Data-access layer for `POST /api/requests` — submitting a request from the
 * New workflow (design: "Requests (user side)" — `POST /api/requests`,
 * R2.14).
 *
 * ── Why an interface + a DB implementation ───────────────────────────────────
 * The route handler (requests.routes.ts) depends on this narrow
 * {@link RequestCreateStore} interface, never on `pg` directly, so it can be
 * unit-tested with an in-memory fake — matching the injectable style used by
 * the team-admin, team-leader, task-leader, data-point and workflow-support
 * stores. The production {@link DbRequestCreateStore} is the only place that
 * talks to Postgres, and it does so exclusively through the parameterised
 * data-access layer (`db/query.ts`): every value travels as a bound
 * placeholder, nothing is interpolated into SQL text.
 *
 * ── What "submit" does (R2.14) ───────────────────────────────────────────────
 * On create the store, inside ONE transaction:
 *   1. Loads the selected task's CURRENT (latest) version and its merged fields
 *      — the same layout task 6.1's workflow-support store serves for Step 2 —
 *      so the server pins and validates against the version actually in use
 *      right now (R16.4). The pinned `task_version_id` keeps the request's
 *      layout stable even if the task is later re-versioned.
 *   2. Validates the entered values SERVER-SIDE against that version's fields
 *      using the shared field-validation service (task 3.7): data-type rules
 *      (R3.1–3.5) and mandatory rules (R3.6). Invalid/missing-mandatory input is
 *      rejected with `VALIDATION_FAILED` / `MANDATORY_FIELD` before anything is
 *      written.
 *   3. Assigns a unique human-facing `task_reference`, sets `status = NEW`
 *      (R9.2), pins `task_version_id`, and records `created_at`/`updated_at`.
 *   4. Persists one `request_field_value` row per entered value.
 *   5. Writes column-level audit rows (R17) for the created request and its
 *      field values, in the SAME transaction as the inserts.
 *   6. Upserts `request_last_seen` for the raiser (R5.2) so a freshly raised
 *      request never shows as "Updated" to its own raiser.
 *
 * A guard/validation failure aborts the whole transaction, so no partial
 * request, orphan field value, or dangling audit row is ever committed.
 */

/**
 * A runner that executes `fn` inside a single database transaction, passing the
 * enlisted queryable. Production uses {@link withTransaction} (a real `pg`
 * transaction); tests inject a runner backed by a fake {@link Queryable} so the
 * store's load/validate/insert/audit SQL is exercised without a live database.
 */
export type TransactionRunner = <T>(
  fn: (tx: Queryable) => Promise<T>,
) => Promise<T>;

/** The production transaction runner: a real `pg` transaction. */
const defaultTransactionRunner: TransactionRunner = (fn) =>
  withTransaction((client) => fn(client));

/** One entered value submitted for a task field (keyed by `task_field.id`). */
export interface SubmittedFieldValue {
  readonly taskFieldId: number;
  /** The raw entered value; may be null/empty for an untouched optional field. */
  readonly value: string | null;
}

/** The validated input accepted by {@link RequestCreateStore.create} (R2.14). */
export interface CreateRequestInput {
  /** The task the request is raised against (its CURRENT version is pinned). */
  readonly taskId: number;
  /** A human-facing request title. */
  readonly title: string;
  /** Optional linked Jira ticket number (R2.8/R5.3). */
  readonly jiraNumber: string | null;
  /** Owner-entered estimate; ISO-8601 string or null (R4.5). */
  readonly estimatedStartDate: string | null;
  /** Actual start; ISO-8601 string or null, may be in the future. */
  readonly actualStartDate: string | null;
  /** The entered field values keyed by task_field (R2.14). */
  readonly fieldValues: readonly SubmittedFieldValue[];
}

/** The created request as returned to the caller (camelCase, ISO dates). */
export interface CreatedRequestRow {
  readonly id: number;
  readonly taskReference: string;
  readonly taskVersionId: number;
  readonly title: string;
  readonly raisedById: number;
  readonly teamId: number;
  readonly assignedMemberId: number | null;
  readonly status: string;
  readonly jiraNumber: string | null;
  readonly estimatedStartDate: string | null;
  readonly actualStartDate: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Raised when the task id does not exist. Mapped to 404 by the route layer. */
export class TaskNotFoundError extends Error {
  constructor(readonly taskId: number) {
    super(`Task ${taskId} not found`);
    this.name = 'TaskNotFoundError';
  }
}

/**
 * Raised when a submitted value references a `task_field` that does not belong
 * to the task's current version (R2.14). Mapped to `VALIDATION_FAILED` (400).
 */
export class UnknownFieldError extends Error {
  constructor(readonly taskFieldId: number) {
    super(`task_field ${taskFieldId} is not part of the task's current version`);
    this.name = 'UnknownFieldError';
  }
}

/** The narrow contract the route handler depends on. */
export interface RequestCreateStore {
  /**
   * Create a request from the New workflow (R2.14): assign a unique reference,
   * set status NEW, pin the task's current version, validate + persist the
   * entered field values, write audit rows and set the raiser's last-seen — all
   * in one transaction. Throws {@link TaskNotFoundError} for an unknown task and
   * validation errors (`MANDATORY_FIELD`/`VALIDATION_FAILED`) for bad input.
   */
  create(
    input: CreateRequestInput,
    raisedById: number,
  ): Promise<CreatedRequestRow>;
}

// ── DB row shapes ─────────────────────────────────────────────────────────────

/** The task + its current version header (one row, or none when absent). */
interface TaskVersionHeaderDbRow {
  task_id: string | number;
  team_id: string | number;
  version_id: string | number;
}

/**
 * A task_field of the current version joined to its data_point — the shape the
 * validator needs (data type, mandatory flag, regexp pattern, option lists).
 */
interface VersionFieldDbRow {
  task_field_id: string | number;
  is_mandatory: boolean;
  options_override: unknown;
  dp_name: string;
  dp_data_type: DataType;
  dp_default_options: unknown;
  dp_regexp_pattern: string | null;
}

/** Shape of the inserted `request` row (snake_case columns). */
interface RequestDbRow {
  id: string | number;
  task_reference: string;
  task_version_id: string | number;
  title: string;
  raised_by_id: string | number;
  team_id: string | number;
  assigned_member_id: string | number | null;
  status: string;
  jira_number: string | null;
  estimated_start_date: Date | string | null;
  actual_start_date: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Normalise a JSONB option column into a string[] or null. */
function toOptionArray(value: unknown): string[] | null {
  if (value == null) {
    return null;
  }
  return (value as unknown[]).map((o) => String(o));
}

/** ISO-8601 UTC string for a `timestamptz` value (design: dates as ISO-8601). */
function toIso(value: Date | string | null): string | null {
  if (value == null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** Normalise a DB `request` row into the API {@link CreatedRequestRow}. */
function toCreatedRequestRow(row: RequestDbRow): CreatedRequestRow {
  return {
    id: Number(row.id),
    taskReference: row.task_reference,
    taskVersionId: Number(row.task_version_id),
    title: row.title,
    raisedById: Number(row.raised_by_id),
    teamId: Number(row.team_id),
    assignedMemberId: row.assigned_member_id == null ? null : Number(row.assigned_member_id),
    status: row.status,
    jiraNumber: row.jira_number,
    estimatedStartDate: toIso(row.estimated_start_date),
    actualStartDate: toIso(row.actual_start_date),
    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at) as string,
  };
}

/**
 * Build a {@link FieldDefinition} for the validator from a current-version
 * field row (R3.5, R16.3). Name and data type come from the data point; the
 * mandatory flag and dropdown option override come from the task field; the
 * effective option list is resolved through {@link resolveOptions} so the
 * workflow and the validator agree on the same list.
 */
function toFieldDefinition(row: VersionFieldDbRow): FieldDefinition {
  return {
    dataType: row.dp_data_type,
    isMandatory: row.is_mandatory,
    regexpPattern: row.dp_regexp_pattern,
    optionsOverride: toOptionArray(row.options_override),
    defaultOptions: toOptionArray(row.dp_default_options),
    name: row.dp_name,
  };
}

/**
 * A unique, human-facing `task_reference` (R2.14). Format `REQ-<ts>-<rand>`:
 * a base-36 timestamp for rough ordering plus random entropy for uniqueness.
 * The database's UNIQUE constraint on `task_reference` remains the authority;
 * this only needs to avoid collisions in practice.
 */
function generateTaskReference(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.floor(Math.random() * 36 ** 6)
    .toString(36)
    .toUpperCase()
    .padStart(6, '0');
  return `REQ-${ts}-${rand}`;
}

/** The audited-field snapshot for a created request (column-level audit, R17). */
function requestSnapshot(row: CreatedRequestRow): FieldSnapshot {
  return {
    task_reference: row.taskReference,
    task_version_id: row.taskVersionId,
    title: row.title,
    raised_by_id: row.raisedById,
    team_id: row.teamId,
    status: row.status,
    jira_number: row.jiraNumber,
    estimated_start_date: row.estimatedStartDate,
    actual_start_date: row.actualStartDate,
  };
}

/**
 * Postgres-backed {@link RequestCreateStore}. All SQL is parameterised; the
 * request insert, its field-value inserts, the audit rows and the raiser's
 * last-seen upsert all share one transaction.
 */
export class DbRequestCreateStore implements RequestCreateStore {
  constructor(
    private readonly audit: AuditWriter = new AuditWriter(),
    private readonly runTransaction: TransactionRunner = defaultTransactionRunner,
    /** Reference generator seam (overridable in tests for determinism). */
    private readonly newReference: () => string = generateTaskReference,
  ) {}

  async create(
    input: CreateRequestInput,
    raisedById: number,
  ): Promise<CreatedRequestRow> {
    return this.runTransaction(async (tx) => {
      // 1. Resolve the task and its CURRENT version header (R16.4/R16.5). Same
      //    join task 6.1's workflow-support store uses to pin/validate.
      const header = await one<TaskVersionHeaderDbRow>(
        `SELECT t.id                 AS task_id,
                t.team_id             AS team_id,
                tv.id                 AS version_id
           FROM task t
           JOIN task_version tv ON tv.id = t.current_version_id
          WHERE t.id = $1`,
        [input.taskId],
        tx,
      );
      if (!header) {
        throw new TaskNotFoundError(input.taskId);
      }
      const versionId = Number(header.version_id);
      const teamId = Number(header.team_id);

      // 2. Load the version's fields (merged with their data points) for
      //    server-side validation and to reject unknown task_field ids.
      const fieldRows = await many<VersionFieldDbRow>(
        `SELECT tf.id               AS task_field_id,
                tf.is_mandatory      AS is_mandatory,
                tf.options_override  AS options_override,
                dp.name              AS dp_name,
                dp.data_type         AS dp_data_type,
                dp.default_options   AS dp_default_options,
                dp.regexp_pattern    AS dp_regexp_pattern
           FROM task_field tf
           JOIN data_point dp ON dp.id = tf.data_point_id
          WHERE tf.task_version_id = $1
          ORDER BY tf.field_order ASC, tf.id ASC`,
        [versionId],
        tx,
      );

      // Index the field definitions by task_field id and index the submitted
      // values so every field is validated (including mandatory fields the
      // caller omitted, which validate as empty → MANDATORY_FIELD, R3.6).
      const fieldById = new Map<number, VersionFieldDbRow>();
      for (const row of fieldRows) {
        fieldById.set(Number(row.task_field_id), row);
      }
      const submittedById = new Map<number, string | null>();
      for (const submitted of input.fieldValues) {
        // A value for a field that is not part of this version is a bad request.
        if (!fieldById.has(submitted.taskFieldId)) {
          throw new UnknownFieldError(submitted.taskFieldId);
        }
        submittedById.set(submitted.taskFieldId, submitted.value);
      }

      // 3. Validate EVERY version field against its submitted value (R3). This
      //    collects all failures and throws MANDATORY_FIELD/VALIDATION_FAILED
      //    (task 3.7) before any write happens.
      const entries: FieldValue[] = fieldRows.map((row) => ({
        field: toFieldDefinition(row),
        value: submittedById.has(Number(row.task_field_id))
          ? submittedById.get(Number(row.task_field_id))
          : null,
      }));
      assertFields(entries);

      // 4. Insert the request: unique reference, status NEW (default), pinned
      //    version, timestamps (created_at/updated_at default now()). (R2.14)
      const reference = this.newReference();
      const inserted = await one<RequestDbRow>(
        `INSERT INTO request
           (task_reference, task_version_id, title, raised_by_id, team_id,
            jira_number, estimated_start_date, actual_start_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, task_reference, task_version_id, title, raised_by_id,
                   team_id, assigned_member_id, status, jira_number,
                   estimated_start_date, actual_start_date, created_at, updated_at`,
        [
          reference,
          versionId,
          input.title,
          raisedById,
          teamId,
          input.jiraNumber,
          input.estimatedStartDate,
          input.actualStartDate,
        ],
        tx,
      );
      if (!inserted) {
        throw new Error('INSERT ... RETURNING produced no row');
      }
      const request = toCreatedRequestRow(inserted);

      // 5. Persist one request_field_value per submitted value (R2.14). Only
      //    fields the caller supplied are stored; omitted optional fields hold
      //    no value (the unique(request,field) constraint keeps them one-per).
      for (const submitted of input.fieldValues) {
        await one<{ id: string | number }>(
          `INSERT INTO request_field_value (request_id, task_field_id, value)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [request.id, submitted.taskFieldId, submitted.value],
          tx,
        );
      }

      // 6. Column-level audit for the created request (first-set: old → NULL),
      //    in the SAME transaction as the insert (R17.1, R17.2).
      await this.audit.recordChanges(
        { entityType: 'request', entityId: request.id, changedById: raisedById },
        {},
        requestSnapshot(request),
        tx,
      );
      // Audit the captured field values too, so the request's initial data is
      // part of the trail (one row per stored value, R17.2).
      for (const submitted of input.fieldValues) {
        await this.audit.recordChanges(
          {
            entityType: 'request_field_value',
            entityId: request.id,
            changedById: raisedById,
          },
          {},
          { [`field_${submitted.taskFieldId}`]: submitted.value },
          tx,
        );
      }

      // 7. Record the raiser's last-seen at creation (R5.2) so their own new
      //    request never shows as "Updated" to them.
      await one<{ id: string | number }>(
        `INSERT INTO request_last_seen (request_id, user_id, last_seen_at)
         VALUES ($1, $2, now())
         ON CONFLICT (request_id, user_id)
         DO UPDATE SET last_seen_at = now(), updated_at = now()
         RETURNING id`,
        [request.id, raisedById],
        tx,
      );

      return request;
    });
  }
}
