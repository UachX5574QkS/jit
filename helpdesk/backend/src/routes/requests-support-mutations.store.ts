import { one, many, withTransaction, type Queryable } from '../db/query.js';
import { AuditWriter } from '../audit/index.js';
import {
  assertFields,
  type DataType,
  type FieldDefinition,
  type FieldValue,
} from '../validation/index.js';
import { assertTransition, isStatus, type Status } from '../status/index.js';
import { autoStopTimersForRequest } from './requests-timer.store.js';

/**
 * Data-access layer for the SUPPORT-side request mutation (design: "Support
 * side" — `PATCH /api/requests/{id}` — support update of any field + status
 * (state-machine checked) + assignment; R7.1, R7.2, R9).
 *
 * ── Why an interface + a DB implementation ───────────────────────────────────
 * The route handler (requests-support-mutations.routes.ts) depends on the
 * narrow {@link RequestSupportMutationsStore} interface, never on `pg`
 * directly, so it unit-tests with an in-memory fake — matching the injectable
 * style of the create/detail/user-mutations stores. The production
 * {@link DbRequestSupportMutationsStore} is the only place that talks to
 * Postgres, and only through the parameterised data-access layer
 * (`db/query.ts`): every value travels as a bound placeholder, nothing is
 * interpolated into SQL text.
 *
 * ── The one operation: updateRequest ────────────────────────────────────────
 * A single support-side PATCH may, in one atomic change (R17):
 *
 *   • update ANY user-entered field value — re-validated against the request's
 *     PINNED task version (types + mandatory) via the shared validation service
 *     (task 3.7). Blanking a mandatory field → `MANDATORY_FIELD`; a type-invalid
 *     value → `VALIDATION_FAILED`; a field outside the pinned version →
 *     {@link UnknownFieldError} (`VALIDATION_FAILED`). (R7.1)
 *   • update the Jira number and (per the design's request columns, R4.5) the
 *     estimated / actual start dates. (R7.1)
 *   • change the status — validated by the central status state machine (R9):
 *     an illegal move surfaces as `INVALID_TRANSITION`; COMPLETE only from
 *     ACTIVE; cancel from any non-stop state; etc. (R9.4–9.7)
 *   • change the assignment — assign to any member of the request's team, or
 *     clear it (unassign). The new assignee MUST be a member of the request's
 *     team, else `VALIDATION_FAILED`. (R7.2)
 *
 * ── Authorisation (R7.1, R7.2) ───────────────────────────────────────────────
 * The actor MUST be a support member of the REQUEST'S team (a member of that
 * team). Any other caller → {@link RequestForbiddenError} (403 FORBIDDEN). The
 * gate lives here because the store knows the request's `team_id`; the route
 * only passes the actor's team memberships.
 *
 * ── Same-transaction audit + updated_at (R7.6, R17) ──────────────────────────
 * Every changed column (field value, jira, dates, status, assignment) is
 * column-level audited through the shared {@link AuditWriter} in the SAME
 * transaction as the write. A support update is a NON-internal change, so it
 * bumps `request.updated_at` — which is what drives the raiser's "Updated"
 * indicator for other viewers (R7.6). A guard/validation failure aborts the
 * whole transaction, so no partial write or dangling audit row is committed.
 *
 * Note on timers (R8, design decision 3): when a status change moves a request
 * OUT of ACTIVE, any running timer on it is auto-stopped-and-recorded (never
 * discarded) via {@link autoStopTimersForRequest}, on the SAME transaction as
 * the status change — so the slice and the transition commit or roll back
 * together.
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
 * Raised when the actor is not a support member of the request's team (R7.1,
 * R7.2). Mapped to 403 FORBIDDEN.
 */
export class RequestForbiddenError extends Error {
  constructor(readonly requestId: number, message?: string) {
    super(message ?? `Not permitted to modify request ${requestId}`);
    this.name = 'RequestForbiddenError';
  }
}

/**
 * Raised when a submitted value references a `task_field` that is not part of
 * the request's pinned task version (R7.1). Mapped to `VALIDATION_FAILED` (400).
 */
export class UnknownFieldError extends Error {
  constructor(readonly taskFieldId: number) {
    super(`task_field ${taskFieldId} is not part of the request's pinned version`);
    this.name = 'UnknownFieldError';
  }
}

/**
 * Raised when the requested new assignee is not a member of the request's team
 * (R7.2). Mapped to `VALIDATION_FAILED` (400).
 */
export class AssigneeNotInTeamError extends Error {
  constructor(
    readonly requestId: number,
    readonly assigneeId: number,
    readonly teamId: number,
  ) {
    super(`User ${assigneeId} is not a member of team ${teamId}`);
    this.name = 'AssigneeNotInTeamError';
  }
}

// ── Public input / output shapes (camelCase, ISO dates) ────────────────────────

/** One field value the support member is updating (keyed by `task_field.id`). */
export interface SupportFieldUpdate {
  readonly taskFieldId: number;
  /** The new raw value; null/blank clears an OPTIONAL field. */
  readonly value: string | null;
}

/**
 * The validated input for {@link RequestSupportMutationsStore.updateRequest}.
 *
 * Every property is OPTIONAL, and `undefined` uniformly means "leave unchanged"
 * (the caller did not include it in the patch). For the nullable columns
 * (jira, dates, assignment) an explicit `null` is a distinct, meaningful value
 * that CLEARS the column.
 */
export interface UpdateRequestInput {
  /** Field values to update; each re-validated against the pinned version. */
  readonly fieldValues?: readonly SupportFieldUpdate[];
  /** New Jira number; null clears it; undefined leaves it unchanged. */
  readonly jiraNumber?: string | null;
  /** New estimated start date (ISO-8601); null clears; undefined unchanged. */
  readonly estimatedStartDate?: string | null;
  /** New actual start date (ISO-8601); null clears; undefined unchanged. */
  readonly actualStartDate?: string | null;
  /** New status; validated by the state machine; undefined unchanged. */
  readonly status?: Status;
  /**
   * New assignee `app_user.id`; must be a member of the request's team. `null`
   * unassigns (clears the owner); `undefined` leaves the assignment unchanged.
   */
  readonly assignedMemberId?: number | null;
}

/** The actor context: their id and the teams they are a member of (R7.1, R7.2). */
export interface SupportActor {
  /** The current user's `app_user.id`. */
  readonly userId: number;
  /** The current user's team memberships (support-member test). */
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

/** The narrow contract the route handler depends on. */
export interface RequestSupportMutationsStore {
  /**
   * A support member of the request's team updates any field, the Jira number,
   * the estimated/actual start dates, the status (state-machine checked), and
   * the assignment (any team member, or unassign) — all in one transaction with
   * column-level audit rows and an `updated_at` bump (R7.1, R7.2, R9, R17,
   * R7.6). Throws {@link RequestNotFoundError} / {@link RequestForbiddenError} /
   * {@link UnknownFieldError} / {@link AssigneeNotInTeamError}; an illegal
   * status move surfaces as `INVALID_TRANSITION`, a bad field value as
   * `MANDATORY_FIELD` / `VALIDATION_FAILED`.
   */
  updateRequest(
    requestId: number,
    input: UpdateRequestInput,
    actor: SupportActor,
  ): Promise<RequestSummary>;
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

/** A pinned-version field joined to its data point (validation). */
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

interface MembershipDbRow {
  is_member: boolean;
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
 * flag and dropdown override from the task field. Mirrors the user-mutations
 * store so the workflow and both mutation paths validate identically.
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
 * Postgres-backed {@link RequestSupportMutationsStore}. All SQL is
 * parameterised; the mutation plus its audit rows and `updated_at` bump share
 * one transaction.
 */
export class DbRequestSupportMutationsStore implements RequestSupportMutationsStore {
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

  async updateRequest(
    requestId: number,
    input: UpdateRequestInput,
    actor: SupportActor,
  ): Promise<RequestSummary> {
    return this.runTransaction(async (tx) => {
      const header = await this.loadHeader(requestId, tx);
      const teamId = Number(header.team_id);

      // A support member of the REQUEST'S team may perform any of these updates
      // (R7.1, R7.2). Membership in the request's team is the authoritative
      // gate; anyone else is FORBIDDEN.
      if (!actor.teamsMemberOf.includes(teamId)) {
        throw new RequestForbiddenError(
          requestId,
          'Only a support member of the request team may update it.',
        );
      }

      const fieldValues = input.fieldValues ?? [];

      // ── Field values: validate against the pinned version, then persist ─────
      if (fieldValues.length > 0) {
        await this.applyFieldValues(requestId, header, fieldValues, actor, tx);
      }

      // ── Jira number ─────────────────────────────────────────────────────────
      if (input.jiraNumber !== undefined && input.jiraNumber !== header.jira_number) {
        await one<{ id: string | number }>(
          `UPDATE request SET jira_number = $2 WHERE id = $1 RETURNING id`,
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

      // ── Estimated / actual start dates (R4.5, R7.1) ──────────────────────────
      await this.applyDateColumn(
        requestId,
        'estimated_start_date',
        input.estimatedStartDate,
        header.estimated_start_date,
        actor,
        tx,
      );
      await this.applyDateColumn(
        requestId,
        'actual_start_date',
        input.actualStartDate,
        header.actual_start_date,
        actor,
        tx,
      );

      // ── Assignment (R7.2): assign to a team member, or unassign ─────────────
      if (input.assignedMemberId !== undefined) {
        await this.applyAssignment(
          requestId,
          teamId,
          input.assignedMemberId,
          header.assigned_member_id,
          actor,
          tx,
        );
      }

      // ── Status (R9): validated by the central state machine ─────────────────
      if (input.status !== undefined) {
        await this.applyStatus(requestId, header.status, input.status, actor, tx);
      }

      // A support update is a non-internal change → bump updated_at so the
      // raiser's "Updated" indicator fires for other viewers (R7.6). Re-read the
      // header to return the up-to-date summary.
      await one<{ id: string | number }>(
        `UPDATE request SET updated_at = now() WHERE id = $1 RETURNING id`,
        [requestId],
        tx,
      );
      return toRequestSummary(await this.loadHeader(requestId, tx));
    });
  }

  /**
   * Re-validate the submitted field values against the request's pinned version
   * (types + mandatory, R7.1) and persist only the ones that actually changed,
   * auditing each. A value targeting a field outside the pinned version is an
   * {@link UnknownFieldError}; a blanked mandatory field → `MANDATORY_FIELD`; a
   * type-invalid value → `VALIDATION_FAILED`. All failures abort the transaction.
   */
  private async applyFieldValues(
    requestId: number,
    header: RequestHeaderDbRow,
    fieldValues: readonly SupportFieldUpdate[],
    actor: SupportActor,
    tx: Queryable,
  ): Promise<void> {
    const versionId = Number(header.task_version_id);

    // Load the pinned version's fields and index by task_field id so updates are
    // validated against the ACTUAL field layout (types + mandatory).
    const fieldRows = await many<VersionFieldDbRow>(VERSION_FIELDS_SQL, [versionId], tx);
    const fieldById = new Map<number, VersionFieldDbRow>();
    for (const row of fieldRows) {
      fieldById.set(Number(row.task_field_id), row);
    }

    // Reject any update targeting a field outside the pinned version (R7.1).
    for (const update of fieldValues) {
      if (!fieldById.has(update.taskFieldId)) {
        throw new UnknownFieldError(update.taskFieldId);
      }
    }

    // Load the CURRENT stored values for the fields so we can audit old→new only
    // when a value actually changes.
    const currentValueById = new Map<number, string | null>();
    const existingRows = await many<FieldValueDbRow>(
      `SELECT task_field_id, value FROM request_field_value WHERE request_id = $1`,
      [requestId],
      tx,
    );
    for (const row of existingRows) {
      currentValueById.set(Number(row.task_field_id), row.value);
    }

    // Re-validate every updated value against its pinned-version definition
    // (R7.1). All failures collected at once by the shared validation service.
    const toValidate: FieldValue[] = fieldValues.map((update) => ({
      field: toFieldDefinition(fieldById.get(update.taskFieldId) as VersionFieldDbRow),
      value: update.value,
    }));
    assertFields(toValidate);

    // Persist only the fields whose value actually changed, upserting the
    // (request, field) row, and audit each change (R17).
    for (const update of fieldValues) {
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
  }

  /**
   * Apply an optional nullable `timestamptz` column update (estimated/actual
   * start date). `undefined` leaves it unchanged; a string/null is written when
   * it differs from the current value, and audited (R17). Comparison is done on
   * the normalised ISO form so a stored Date and its ISO string compare equal.
   */
  private async applyDateColumn(
    requestId: number,
    column: 'estimated_start_date' | 'actual_start_date',
    next: string | null | undefined,
    current: Date | string | null,
    actor: SupportActor,
    tx: Queryable,
  ): Promise<void> {
    if (next === undefined) {
      return;
    }
    const currentIso = toIso(current);
    const nextIso = next === null ? null : toIso(next);
    if (currentIso === nextIso) {
      return; // No-op: nothing to write or audit.
    }
    // The column name is a code-controlled constant (never request input), so
    // interpolating it into the SQL text is safe; the VALUE is still bound.
    await one<{ id: string | number }>(
      `UPDATE request SET ${column} = $2 WHERE id = $1 RETURNING id`,
      [requestId, next],
      tx,
    );
    await this.audit.recordChanges(
      { entityType: 'request', entityId: requestId, changedById: actor.userId },
      { [column]: currentIso },
      { [column]: nextIso },
      tx,
    );
  }

  /**
   * Apply an assignment change (R7.2). A non-null assignee MUST be a member of
   * the request's team, else {@link AssigneeNotInTeamError}; `null` unassigns.
   * Writes + audits only when the assignment actually changes.
   */
  private async applyAssignment(
    requestId: number,
    teamId: number,
    next: number | null,
    current: string | number | null,
    actor: SupportActor,
    tx: Queryable,
  ): Promise<void> {
    const currentId = current == null ? null : Number(current);
    if (currentId === next) {
      return; // No-op: nothing to write or audit.
    }

    // A non-null assignee must be a member of the request's team (R7.2). The
    // team_member table is the authoritative membership record.
    if (next !== null) {
      const membership = await one<MembershipDbRow>(
        `SELECT EXISTS (
           SELECT 1 FROM team_member WHERE team_id = $1 AND user_id = $2
         ) AS is_member`,
        [teamId, next],
        tx,
      );
      if (!membership || membership.is_member !== true) {
        throw new AssigneeNotInTeamError(requestId, next, teamId);
      }
    }

    await one<{ id: string | number }>(
      `UPDATE request SET assigned_member_id = $2 WHERE id = $1 RETURNING id`,
      [requestId, next],
      tx,
    );
    await this.audit.recordChanges(
      { entityType: 'request', entityId: requestId, changedById: actor.userId },
      { assigned_member_id: currentId },
      { assigned_member_id: next },
      tx,
    );
  }

  /**
   * Apply a status change validated by the central state machine (R9). An
   * illegal move surfaces as `INVALID_TRANSITION`; a no-op (same status) is
   * skipped. Writes + audits the status column (old→new) in the transaction.
   */
  private async applyStatus(
    requestId: number,
    currentRaw: string,
    next: Status,
    actor: SupportActor,
    tx: Queryable,
  ): Promise<void> {
    if (!isStatus(currentRaw)) {
      throw new Error(`Unknown stored status ${currentRaw} on request ${requestId}`);
    }
    const current = currentRaw;
    if (current === next) {
      return; // No-op: not a transition.
    }
    // The central state machine is the single source of truth for R9.4–9.7:
    // COMPLETE only from ACTIVE, cancel-from-any-non-stop, everything else
    // rejected as INVALID_TRANSITION. Support updates never take the constrained
    // raiser reopen edge (that is the user-side flow, R5.6).
    assertTransition(current, next);

    await one<{ id: string | number }>(
      `UPDATE request SET status = $2 WHERE id = $1 RETURNING id`,
      [requestId, next],
      tx,
    );
    await this.audit.recordChanges(
      { entityType: 'request', entityId: requestId, changedById: actor.userId },
      { status: current },
      { status: next },
      tx,
    );

    // R8 / design decision 3: leaving ACTIVE auto-stops-and-records any running
    // timer(s) on this request, up to now, on THIS transaction — a running
    // timer is never silently discarded. (Entering ACTIVE, or moves between
    // non-ACTIVE states, leave timers untouched.)
    if (current === 'ACTIVE' && next !== 'ACTIVE') {
      await autoStopTimersForRequest(requestId, new Date(), tx, this.audit);
    }
  }
}
