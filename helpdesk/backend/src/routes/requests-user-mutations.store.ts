import { one, many, withTransaction, type Queryable } from '../db/query.js';
import { AuditWriter } from '../audit/index.js';
import {
  assertFields,
  resolveOptions,
  type DataType,
  type FieldDefinition,
  type FieldValue,
} from '../validation/index.js';
import {
  assertReopen,
  assertTransition,
  isStatus,
  isStopState,
  type Status,
} from '../status/index.js';

/**
 * Data-access layer for the user-side request mutations (design: "Requests
 * (user side)" — `PATCH /api/requests/{id}/user-fields`, `POST .../notes`,
 * `POST .../cancel`, `POST .../reopen`, `POST .../clone`; R5.3–5.8).
 *
 * ── Why an interface + a DB implementation ───────────────────────────────────
 * The route handlers (requests-user-mutations.routes.ts) depend on this narrow
 * {@link RequestUserMutationsStore} interface, never on `pg` directly, so they
 * unit-test with an in-memory fake — matching the injectable style used by the
 * request-create and request-detail stores. The production
 * {@link DbRequestUserMutationsStore} is the only place that talks to Postgres,
 * and it does so exclusively through the parameterised data-access layer
 * (`db/query.ts`): every value travels as a bound placeholder, nothing is
 * interpolated into SQL text.
 *
 * ── The five operations ──────────────────────────────────────────────────────
 * All mutations run in ONE transaction with their column-level audit rows
 * (R17), and — being non-internal changes — bump `request.updated_at` so the
 * raiser's "Updated" indicator fires for other viewers (R7.6). The RAISER-only
 * gate is enforced here (the store knows the request's `raised_by_id`).
 *
 *   1. updateUserFields (R5.4) — the raiser updates the Jira number and any
 *      user-entered field values. Each updated value is RE-VALIDATED against the
 *      request's PINNED task-version field definitions (types + mandatory) via
 *      the shared validation service (task 3.7). Blanking a mandatory field is
 *      rejected with `MANDATORY_FIELD`; a type-invalid value with
 *      `VALIDATION_FAILED`. Only the changed `request_field_value` rows and the
 *      Jira column are written, each audited.
 *
 *   (Add-note is NOT here: the raiser's external note and the support member's
 *   internal/external note share ONE endpoint — `POST /api/requests/{id}/notes`
 *   — so the operation lives in the unified notes store (requests-notes.store.ts,
 *   R5.3 + R7.3–7.6). This store keeps the raiser's field/cancel/reopen/clone
 *   mutations.)
 *
 *   3. cancel (R5.5) — raiser only; only from a NON-stop state. Moves the status
 *      to CANCELLED through the state machine (cancel-from-any-non-stop, R9.6).
 *      The status audit row records who cancelled, which gates reopen.
 *
 *   4. reopen (R5.6) — only the raiser who CANCELLED the request, only from
 *      CANCELLED; returns the status to NEW via the constrained reopen edge
 *      (R5.6). "Who cancelled" is read from the audit trail (the most recent
 *      status → CANCELLED entry): if that user is not the current user, reopen
 *      is FORBIDDEN. Any other source state is `INVALID_TRANSITION`.
 *
 *   5. cloneDraft (R5.8) — returns a pre-populated DRAFT for the New workflow
 *      Step 2 (the original's task/version fields + entered values, status
 *      conceptually NEW) WITHOUT persisting anything; the real create happens
 *      via `POST /api/requests`. Any authorised VIEWER of the request may clone.
 *
 * A guard/validation failure aborts the whole transaction, so no partial write,
 * orphan value, or dangling audit row is ever committed. R5.7 is enforced by
 * construction: the only status changes this store performs are cancel/reopen.
 */

// ── Shared error types (mapped to the uniform envelope by the route layer) ─────

/** Raised when the request id does not exist. Mapped to 404 NOT_FOUND. */
export class RequestNotFoundError extends Error {
  constructor(readonly requestId: number) {
    super(`Request ${requestId} not found`);
    this.name = 'RequestNotFoundError';
  }
}

/**
 * Raised when the current user may not perform the mutation (not the raiser, or
 * not the raiser who cancelled, or not an authorised viewer for clone). Mapped
 * to 403 FORBIDDEN.
 */
export class RequestForbiddenError extends Error {
  constructor(readonly requestId: number, message?: string) {
    super(message ?? `Not permitted to modify request ${requestId}`);
    this.name = 'RequestForbiddenError';
  }
}

/**
 * Raised when a submitted value references a `task_field` that is not part of
 * the request's pinned task version (R5.4). Mapped to `VALIDATION_FAILED` (400).
 */
export class UnknownFieldError extends Error {
  constructor(readonly taskFieldId: number) {
    super(`task_field ${taskFieldId} is not part of the request's pinned version`);
    this.name = 'UnknownFieldError';
  }
}

// ── Public input / output shapes (camelCase, ISO dates) ────────────────────────

/** One field value the raiser is updating (keyed by `task_field.id`). */
export interface UserFieldUpdate {
  readonly taskFieldId: number;
  /** The new raw value; null/blank clears an OPTIONAL field (R5.4). */
  readonly value: string | null;
}

/** The validated input for {@link RequestUserMutationsStore.updateUserFields}. */
export interface UpdateUserFieldsInput {
  /**
   * The new Jira number, or null to clear it. `undefined` means "leave the Jira
   * number unchanged" (the caller did not include it in the patch).
   */
  readonly jiraNumber?: string | null;
  /** The field values to update; each is re-validated against the pinned version. */
  readonly fieldValues: readonly UserFieldUpdate[];
}

/** The viewer context every operation needs (raiser gating, clone visibility). */
export interface MutationActor {
  /** The current user's `app_user.id`. */
  readonly userId: number;
  /** The current user's team memberships (support-viewer test for clone). */
  readonly teamsMemberOf: ReadonlyArray<number>;
}

/** The request header fields returned after a mutation (camelCase, ISO dates). */
export interface RequestSummary {
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

/** One field of the pinned version merged with the original entered value (R5.8). */
export interface CloneFieldView {
  readonly taskFieldId: number;
  readonly dataPointId: number;
  readonly fieldOrder: number;
  readonly name: string;
  readonly dataType: DataType;
  readonly isMandatory: boolean;
  readonly description: string | null;
  readonly helpText: string | null;
  readonly options: string[] | null;
  readonly regexpPattern: string | null;
  /** The original request's value for this field, echoed for pre-population. */
  readonly value: string | null;
}

/**
 * A pre-populated DRAFT for the New workflow Step 2 (R5.8). Conceptually a NEW
 * request; NOT persisted — the real create is a subsequent `POST /api/requests`.
 */
export interface CloneDraft {
  /** The task the draft is for (its CURRENT version is what the New workflow pins). */
  readonly taskId: number;
  readonly taskName: string;
  readonly teamId: number;
  /** The pinned version of the SOURCE request (what its values were entered against). */
  readonly sourceTaskVersionId: number;
  readonly sourceVersionNo: number;
  /** Title echoed from the source request. */
  readonly title: string;
  /** Jira echoed from the source request (may be null). */
  readonly jiraNumber: string | null;
  /** Conceptual status of the draft — always NEW (R5.8). */
  readonly status: 'NEW';
  /** The source version's fields, in order, merged with the source's values. */
  readonly fields: CloneFieldView[];
}

/** The narrow contract the route handlers depend on. */
export interface RequestUserMutationsStore {
  /**
   * The raiser updates the Jira number and any user-entered field values
   * (R5.4). Re-validates each updated value against the request's pinned version
   * (types + mandatory); blanking a mandatory field → `MANDATORY_FIELD`, a
   * type-invalid value → `VALIDATION_FAILED`. Writes only the changed columns +
   * their audit rows in one transaction and bumps `updated_at`. Throws
   * {@link RequestNotFoundError} / {@link RequestForbiddenError} /
   * {@link UnknownFieldError}.
   */
  updateUserFields(
    requestId: number,
    input: UpdateUserFieldsInput,
    actor: MutationActor,
  ): Promise<RequestSummary>;

  /**
   * The raiser cancels the request (R5.5): only from a NON-stop state, moving
   * the status to CANCELLED through the state machine. The status audit row
   * records who cancelled (gates reopen). Throws
   * {@link RequestNotFoundError} / {@link RequestForbiddenError}; an illegal
   * move surfaces as `INVALID_TRANSITION`.
   */
  cancel(requestId: number, actor: MutationActor): Promise<RequestSummary>;

  /**
   * The raiser who cancelled the request reopens it (R5.6): only from
   * CANCELLED, returning the status to NEW. If the current user is not the one
   * who cancelled it → {@link RequestForbiddenError}; a non-CANCELLED source →
   * `INVALID_TRANSITION`.
   */
  reopen(requestId: number, actor: MutationActor): Promise<RequestSummary>;

  /**
   * Return a pre-populated DRAFT for the New workflow Step 2 (R5.8) WITHOUT
   * persisting anything. Any authorised viewer of the request may clone; a
   * non-viewer → {@link RequestForbiddenError}.
   */
  cloneDraft(requestId: number, actor: MutationActor): Promise<CloneDraft>;
}

// ── DB row shapes ─────────────────────────────────────────────────────────────

interface RequestHeaderDbRow {
  id: string | number;
  task_reference: string;
  task_version_id: string | number;
  task_id: string | number;
  task_name: string;
  version_no: number;
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

/** A pinned-version field joined to its data point (validation + clone merge). */
interface VersionFieldDbRow {
  task_field_id: string | number;
  data_point_id: string | number;
  field_order: number;
  is_mandatory: boolean;
  description_override: string | null;
  help_text_override: string | null;
  options_override: unknown;
  dp_name: string;
  dp_data_type: DataType;
  dp_description: string | null;
  dp_default_help_text: string | null;
  dp_default_options: unknown;
  dp_regexp_pattern: string | null;
}

interface FieldValueDbRow {
  task_field_id: string | number;
  value: string | null;
}

interface VisibilityDbRow {
  visible: boolean;
}

interface CancellerDbRow {
  changed_by_id: string | number;
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

/** Normalise a request header row into the API {@link RequestSummary}. */
function toRequestSummary(row: RequestHeaderDbRow): RequestSummary {
  return {
    id: Number(row.id),
    taskReference: row.task_reference,
    taskVersionId: Number(row.task_version_id),
    title: row.title,
    raisedById: Number(row.raised_by_id),
    teamId: Number(row.team_id),
    assignedMemberId:
      row.assigned_member_id == null ? null : Number(row.assigned_member_id),
    status: row.status,
    jiraNumber: row.jira_number,
    estimatedStartDate: toIso(row.estimated_start_date),
    actualStartDate: toIso(row.actual_start_date),
    createdAt: toIso(row.created_at) as string,
    updatedAt: toIso(row.updated_at) as string,
  };
}

/**
 * Build a {@link FieldDefinition} for the validator from a pinned-version field
 * row (R3.5, R16.3). Name and data type come from the data point; the mandatory
 * flag and dropdown override from the task field; the effective option list is
 * resolved through {@link resolveOptions} so the workflow and validator agree.
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

/** Merge one field row + its (source) value into a clone field view (R5.8). */
function toCloneFieldView(
  row: VersionFieldDbRow,
  value: string | null,
): CloneFieldView {
  const optionsOverride = toOptionArray(row.options_override);
  const defaultOptions = toOptionArray(row.dp_default_options);

  let options: string[] | null = null;
  if (row.dp_data_type === 'DROPDOWN') {
    options = [
      ...resolveOptions({
        dataType: row.dp_data_type,
        isMandatory: row.is_mandatory,
        optionsOverride,
        defaultOptions,
      }),
    ];
  }

  return {
    taskFieldId: Number(row.task_field_id),
    dataPointId: Number(row.data_point_id),
    fieldOrder: row.field_order,
    name: row.dp_name,
    dataType: row.dp_data_type,
    isMandatory: row.is_mandatory,
    description:
      row.description_override != null ? row.description_override : row.dp_description,
    helpText:
      row.help_text_override != null ? row.help_text_override : row.dp_default_help_text,
    options,
    regexpPattern: row.dp_data_type === 'REGEXP' ? row.dp_regexp_pattern : null,
    value,
  };
}

/**
 * A runner that executes `fn` inside a single database transaction. Production
 * uses {@link withTransaction}; tests inject a pass-through backed by a fake
 * {@link Queryable}. Each mutation shares one transaction with its audit rows.
 */
export type TransactionRunner = <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T>;

const defaultTransactionRunner: TransactionRunner = (fn) =>
  withTransaction((client) => fn(client));

/** The SQL selecting a request header joined to its pinned version + task. */
const HEADER_SQL = `SELECT r.id                   AS id,
        r.task_reference        AS task_reference,
        r.task_version_id       AS task_version_id,
        t.id                    AS task_id,
        t.name                  AS task_name,
        tv.version_no           AS version_no,
        r.title                 AS title,
        r.raised_by_id          AS raised_by_id,
        r.team_id               AS team_id,
        r.assigned_member_id    AS assigned_member_id,
        r.status                AS status,
        r.jira_number           AS jira_number,
        r.estimated_start_date  AS estimated_start_date,
        r.actual_start_date     AS actual_start_date,
        r.created_at            AS created_at,
        r.updated_at            AS updated_at
   FROM request r
   JOIN task_version tv ON tv.id = r.task_version_id
   JOIN task t          ON t.id = tv.task_id
  WHERE r.id = $1`;

/** The SQL selecting the pinned version's fields merged with their data points. */
const VERSION_FIELDS_SQL = `SELECT tf.id                 AS task_field_id,
        tf.data_point_id      AS data_point_id,
        tf.field_order        AS field_order,
        tf.is_mandatory       AS is_mandatory,
        tf.description_override AS description_override,
        tf.help_text_override AS help_text_override,
        tf.options_override   AS options_override,
        dp.name               AS dp_name,
        dp.data_type          AS dp_data_type,
        dp.description        AS dp_description,
        dp.default_help_text  AS dp_default_help_text,
        dp.default_options    AS dp_default_options,
        dp.regexp_pattern     AS dp_regexp_pattern
   FROM task_field tf
   JOIN data_point dp ON dp.id = tf.data_point_id
  WHERE tf.task_version_id = $1
  ORDER BY tf.field_order ASC, tf.id ASC`;

/**
 * Postgres-backed {@link RequestUserMutationsStore}. All SQL is parameterised;
 * each mutation plus its audit rows and `updated_at` bump share one transaction.
 */
export class DbRequestUserMutationsStore implements RequestUserMutationsStore {
  constructor(
    private readonly audit: AuditWriter = new AuditWriter(),
    private readonly runTransaction: TransactionRunner = defaultTransactionRunner,
  ) {}

  /** Load the request header or throw {@link RequestNotFoundError}. */
  private async loadHeader(
    requestId: number,
    tx: Queryable,
  ): Promise<RequestHeaderDbRow> {
    const header = await one<RequestHeaderDbRow>(HEADER_SQL, [requestId], tx);
    if (!header) {
      throw new RequestNotFoundError(requestId);
    }
    return header;
  }

  async updateUserFields(
    requestId: number,
    input: UpdateUserFieldsInput,
    actor: MutationActor,
  ): Promise<RequestSummary> {
    return this.runTransaction(async (tx) => {
      const header = await this.loadHeader(requestId, tx);

      // Only the raiser may update user fields (R5.4).
      if (Number(header.raised_by_id) !== actor.userId) {
        throw new RequestForbiddenError(
          requestId,
          'Only the person who raised the request may update its fields.',
        );
      }

      const versionId = Number(header.task_version_id);

      // Load the pinned version's fields and index by task_field id so we can
      // validate updates against the ACTUAL field layout (types + mandatory).
      const fieldRows = await many<VersionFieldDbRow>(
        VERSION_FIELDS_SQL,
        [versionId],
        tx,
      );
      const fieldById = new Map<number, VersionFieldDbRow>();
      for (const row of fieldRows) {
        fieldById.set(Number(row.task_field_id), row);
      }

      // Reject any update targeting a field outside the pinned version (R5.4).
      for (const update of input.fieldValues) {
        if (!fieldById.has(update.taskFieldId)) {
          throw new UnknownFieldError(update.taskFieldId);
        }
      }

      // Load the CURRENT stored values for the fields being updated, so we can
      // (a) audit old→new only when a value actually changes, and (b) validate
      // the incoming values against their definitions.
      const currentValueById = new Map<number, string | null>();
      const existingRows = await many<FieldValueDbRow>(
        `SELECT task_field_id, value
           FROM request_field_value
          WHERE request_id = $1`,
        [requestId],
        tx,
      );
      for (const row of existingRows) {
        currentValueById.set(Number(row.task_field_id), row.value);
      }

      // Re-validate every updated value against its pinned-version definition
      // (R5.4). Blanking a mandatory field validates as empty → MANDATORY_FIELD;
      // a type-invalid value → VALIDATION_FAILED. All failures collected at once.
      const toValidate: FieldValue[] = input.fieldValues.map((update) => ({
        field: toFieldDefinition(fieldById.get(update.taskFieldId) as VersionFieldDbRow),
        value: update.value,
      }));
      assertFields(toValidate);

      // Persist only the fields whose value actually changed, upserting the
      // (request, field) row, and audit each change (R17). The unique
      // (request, field) constraint keeps at most one value per field.
      for (const update of input.fieldValues) {
        const previous = currentValueById.has(update.taskFieldId)
          ? (currentValueById.get(update.taskFieldId) as string | null)
          : null;
        if (previous === update.value) {
          continue; // No-op: nothing to write or audit.
        }
        await one<{ id: string | number }>(
          `INSERT INTO request_field_value (request_id, task_field_id, value)
           VALUES ($1, $2, $3)
           ON CONFLICT (request_id, task_field_id)
           DO UPDATE SET value = EXCLUDED.value, updated_at = now()
           RETURNING id`,
          [requestId, update.taskFieldId, update.value],
          tx,
        );
        await this.audit.recordChanges(
          {
            entityType: 'request_field_value',
            entityId: requestId,
            changedById: actor.userId,
          },
          { [`field_${update.taskFieldId}`]: previous },
          { [`field_${update.taskFieldId}`]: update.value },
          tx,
        );
      }

      // Update the Jira number when the patch included it AND it changed (R5.4).
      // `undefined` means "leave unchanged"; null/string are explicit values.
      if (input.jiraNumber !== undefined && input.jiraNumber !== header.jira_number) {
        await one<{ id: string | number }>(
          `UPDATE request
              SET jira_number = $2
            WHERE id = $1
            RETURNING id`,
          [requestId, input.jiraNumber],
          tx,
        );
        await this.audit.recordChanges(
          { entityType: 'request', entityId: requestId, changedById: actor.userId },
          { jira_number: header.jira_number },
          { jira_number: input.jiraNumber },
          tx,
        );
      }

      // Bump updated_at: a user-field update is a non-internal change, so it
      // must move the "Updated" indicator for other viewers (R7.6). Re-read the
      // header to return the up-to-date summary.
      await one<{ id: string | number }>(
        `UPDATE request SET updated_at = now() WHERE id = $1 RETURNING id`,
        [requestId],
        tx,
      );
      return toRequestSummary(await this.loadHeader(requestId, tx));
    });
  }

  async cancel(requestId: number, actor: MutationActor): Promise<RequestSummary> {
    return this.runTransaction(async (tx) => {
      const header = await this.loadHeader(requestId, tx);

      // Only the raiser may cancel (R5.5).
      if (Number(header.raised_by_id) !== actor.userId) {
        throw new RequestForbiddenError(
          requestId,
          'Only the person who raised the request may cancel it.',
        );
      }

      const current = header.status;
      if (!isStatus(current)) {
        throw new Error(`Unknown stored status ${current} on request ${requestId}`);
      }

      // Cancel is only valid from a NON-stop state (R5.5, R9.6). The state
      // machine enforces "→ CANCELLED from any non-stop state"; an attempt from
      // a stop state surfaces as INVALID_TRANSITION.
      assertTransition(current, 'CANCELLED');

      const updated = await this.applyStatus(
        requestId,
        current,
        'CANCELLED',
        actor.userId,
        tx,
      );
      return updated;
    });
  }

  async reopen(requestId: number, actor: MutationActor): Promise<RequestSummary> {
    return this.runTransaction(async (tx) => {
      const header = await this.loadHeader(requestId, tx);

      // Only the raiser may reopen, and only the raiser who CANCELLED it (R5.6).
      if (Number(header.raised_by_id) !== actor.userId) {
        throw new RequestForbiddenError(
          requestId,
          'Only the person who raised the request may reopen it.',
        );
      }

      const current = header.status;
      if (!isStatus(current)) {
        throw new Error(`Unknown stored status ${current} on request ${requestId}`);
      }

      // The status move must be the constrained reopen edge CANCELLED → NEW
      // (R5.6). A non-CANCELLED source surfaces as INVALID_TRANSITION.
      assertReopen(current, 'NEW');

      // Gate on WHO cancelled it: the most recent status → CANCELLED audit entry
      // must have been made by the current user (R5.6). The audit trail is the
      // authoritative record of who performed the cancel.
      const canceller = await one<CancellerDbRow>(
        `SELECT changed_by_id
           FROM audit_entry
          WHERE entity_type = 'request'
            AND entity_id = $1
            AND field_name = 'status'
            AND new_value = 'CANCELLED'
          ORDER BY changed_at DESC, id DESC
          LIMIT 1`,
        [requestId],
        tx,
      );
      if (!canceller || Number(canceller.changed_by_id) !== actor.userId) {
        throw new RequestForbiddenError(
          requestId,
          'Only the person who cancelled the request may reopen it.',
        );
      }

      return this.applyStatus(requestId, current, 'NEW', actor.userId, tx);
    });
  }

  /**
   * Apply a status change: UPDATE the row, audit the status column (old→new),
   * and bump `updated_at`. Shared by cancel/reopen. Runs on the supplied
   * transaction so the write and its audit commit together (R17).
   */
  private async applyStatus(
    requestId: number,
    from: Status,
    to: Status,
    changedById: number,
    tx: Queryable,
  ): Promise<RequestSummary> {
    const updated = await one<RequestHeaderDbRow>(
      `UPDATE request
          SET status = $2, updated_at = now()
        WHERE id = $1
        RETURNING id`,
      [requestId, to],
      tx,
    );
    if (!updated) {
      throw new RequestNotFoundError(requestId);
    }
    await this.audit.recordChanges(
      { entityType: 'request', entityId: requestId, changedById },
      { status: from },
      { status: to },
      tx,
    );
    return toRequestSummary(await this.loadHeader(requestId, tx));
  }

  async cloneDraft(requestId: number, actor: MutationActor): Promise<CloneDraft> {
    return this.runTransaction(async (tx) => {
      const header = await this.loadHeader(requestId, tx);

      const teamId = Number(header.team_id);
      const raisedById = Number(header.raised_by_id);
      const versionId = Number(header.task_version_id);

      // Any AUTHORISED VIEWER of the request may clone (R5.8): the raiser, a
      // support member of the request's team, or a manager in the raiser's
      // upward hierarchy. Mirrors the request-detail visibility rule so a user
      // who can open a request can also clone it.
      const isRaiser = raisedById === actor.userId;
      const isSupportViewer = actor.teamsMemberOf.includes(teamId);
      let canView = isRaiser || isSupportViewer;
      if (!canView) {
        const vis = await one<VisibilityDbRow>(
          `WITH RECURSIVE chain (user_id, manager_id, depth) AS (
             SELECT u.id, u.manager_id, 1
               FROM app_user u
              WHERE u.id = $1
             UNION ALL
             SELECT u.id, u.manager_id, c.depth + 1
               FROM app_user u
               JOIN chain c ON u.id = c.manager_id
              WHERE c.depth < 100
           )
           SELECT EXISTS (
             SELECT 1 FROM chain WHERE manager_id = $2
           ) AS visible`,
          [raisedById, actor.userId],
          tx,
        );
        canView = vis?.visible === true;
      }
      if (!canView) {
        throw new RequestForbiddenError(
          requestId,
          'You are not permitted to clone this request.',
        );
      }

      // Load the source version's fields (merged with data points) and the
      // source request's entered values so the draft echoes them (R5.8).
      const fieldRows = await many<VersionFieldDbRow>(
        VERSION_FIELDS_SQL,
        [versionId],
        tx,
      );
      const valueRows = await many<FieldValueDbRow>(
        `SELECT task_field_id, value
           FROM request_field_value
          WHERE request_id = $1`,
        [requestId],
        tx,
      );
      const valueById = new Map<number, string | null>();
      for (const row of valueRows) {
        valueById.set(Number(row.task_field_id), row.value);
      }

      const fields = fieldRows.map((row) =>
        toCloneFieldView(row, valueById.get(Number(row.task_field_id)) ?? null),
      );

      // The draft is NOT persisted (R5.8). It is a NEW-workflow Step 2
      // pre-population; the real create is a subsequent POST /api/requests.
      return {
        taskId: Number(header.task_id),
        taskName: header.task_name,
        teamId,
        sourceTaskVersionId: versionId,
        sourceVersionNo: header.version_no,
        title: header.title,
        jiraNumber: header.jira_number,
        status: 'NEW',
        fields,
      };
    });
  }
}

/** Re-export the stop-state predicate for callers that need it (R5.5). */
export { isStopState };
