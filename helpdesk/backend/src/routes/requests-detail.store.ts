import { one, many, withTransaction, type Queryable } from '../db/query.js';
import { resolveOptions, type DataType } from '../validation/index.js';

/**
 * Data-access layer for `GET /api/requests/{id}` — the request detail read
 * (design: "Requests (user side)" — `GET /api/requests/{id}` — detail incl.
 * audit, internal notes excluded for non-support viewers (R5.1); records
 * `last_seen` (R5.2); R17.4).
 *
 * ── Why an interface + a DB implementation ───────────────────────────────────
 * The route handler (requests-detail.routes.ts) depends on this narrow
 * {@link RequestDetailStore} interface, never on `pg` directly, so it can be
 * unit-tested with an in-memory fake — matching the injectable style used by
 * the workflow-support, request-create, team-admin, team-leader and task-leader
 * stores. The production {@link DbRequestDetailStore} is the only place that
 * talks to Postgres, and it does so exclusively through the parameterised
 * data-access layer (`db/query.ts`): every value travels as a bound
 * placeholder, nothing is interpolated into SQL text.
 *
 * ── What "detail" assembles (R5.1, R17.4) ────────────────────────────────────
 * Opening a request returns, in ONE transaction:
 *   1. The request row (with its pinned task version's task name / version no).
 *   2. The pinned task version's fields, in order, each merged with its data
 *      point (name/data type from the data point, description/help/options
 *      preferring the field override) — the SAME merge task 6.1's
 *      workflow-support store performs — and joined to the entered value
 *      (`request_field_value`) so the caller sees the field layout AND the
 *      values together (R5.1).
 *   3. The request's notes, oldest-first.
 *   4. The column-level audit trail for the request AND for its notes (R17,
 *      R17.4).
 *   5. Then it upserts `request_last_seen` for the viewer, clearing their
 *      "Updated" indicator (R5.2), using the same upsert convention as the
 *      request-create store (task 6.3).
 *
 * ── Support viewer vs non-support viewer (R5.1, R17.4, R7.3) ──────────────────
 * A viewer is a SUPPORT viewer for this request when they are a member of the
 * request's team (`app_user` in `team_member` for `request.team_id`). Support
 * viewers see EVERYTHING — internal notes and the audit entries about them.
 * NON-support viewers (the raiser, a manager in their hierarchy, …) must NOT
 * see internal notes (`is_internal = true`) NOR any audit entry that describes
 * an internal note (R5.1, R17.4, R7.3). The store applies that exclusion when
 * `isSupportViewer` is false: internal notes are dropped, and audit entries
 * whose `entity_type = 'request_note'` and `entity_id` is an internal note are
 * dropped from the trail.
 *
 * ── Visibility (who may open a request at all) ────────────────────────────────
 * Distinct from support-vs-non-support. A request is viewable by: its RAISER, a
 * SUPPORT member of its team, or a MANAGER anywhere in the raiser's upward
 * management hierarchy (R19 self-FK `app_user.manager_id`). Anyone else is
 * denied. The store reports a denial via {@link RequestForbiddenError}; an
 * unknown id via {@link RequestNotFoundError}. Both are mapped by the route
 * layer (404 / 403 respectively).
 */

/**
 * The context the caller (route) supplies about the current viewer.
 *
 * The store determines SUPPORT-ness for a request by testing whether the
 * viewer's team memberships include the request's own `team_id` (R5.1/R7.3).
 * Passing the membership set — a plain array of team ids — rather than a
 * pre-computed flag resolves the chicken-and-egg: the request's team is not
 * known until the store loads the header, so the store applies the membership
 * test itself, and does so BEFORE assembling notes/audit so internal content is
 * excluded for a non-support viewer. Only a `number[]` crosses the seam, so the
 * store never depends on the full identity shape.
 */
export interface DetailViewer {
  /** The current user's `app_user.id`. */
  readonly userId: number;
  /**
   * The team ids the current user is a member of (`CurrentUser.teamsMemberOf`).
   * The viewer is a SUPPORT viewer for a request when this includes the
   * request's `team_id`.
   */
  readonly teamsMemberOf: ReadonlyArray<number>;
}

/** One field of the pinned version merged with its entered value (R5.1). */
export interface RequestFieldView {
  /** The task_field id (identifies the field within the pinned version). */
  readonly taskFieldId: number;
  /** The underlying data point id. */
  readonly dataPointId: number;
  /** Display order within the version (ascending). */
  readonly fieldOrder: number;
  /** Field label — always the data point name (not overridable, R16.3). */
  readonly name: string;
  /** Field data type — always the data point type (not overridable, R16.3). */
  readonly dataType: DataType;
  /** Whether the field is mandatory (R3.6). */
  readonly isMandatory: boolean;
  /** Description: field override, else data point default (may be null). */
  readonly description: string | null;
  /** "?" help text: field override, else data point default (may be null). */
  readonly helpText: string | null;
  /** DROPDOWN effective option list (override else default); null otherwise. */
  readonly options: string[] | null;
  /** REGEXP validation pattern from the data point; null otherwise. */
  readonly regexpPattern: string | null;
  /** The entered value for this field, or null when unset. */
  readonly value: string | null;
}

/** A note on the request (R5.3, R7.3–7.4). */
export interface RequestNoteView {
  readonly id: number;
  readonly authorId: number;
  /** True for support-only internal notes (never returned to non-support). */
  readonly isInternal: boolean;
  readonly body: string;
  readonly createdAt: string;
}

/** One column-level audit entry in the request's trail (R17). */
export interface AuditEntryView {
  readonly id: number;
  /** The audited entity kind, e.g. `'request'` or `'request_note'`. */
  readonly entityType: string;
  readonly entityId: number;
  readonly fieldName: string;
  readonly oldValue: string | null;
  readonly newValue: string | null;
  readonly changedById: number;
  readonly changedAt: string;
}

/** The full request detail returned by the store (camelCase, ISO dates). */
export interface RequestDetailView {
  readonly id: number;
  readonly taskReference: string;
  readonly taskVersionId: number;
  readonly taskId: number;
  readonly taskName: string;
  readonly versionNo: number;
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
  /** The pinned version's fields, in order, merged with their entered values. */
  readonly fields: RequestFieldView[];
  /** The request's notes, oldest first (internal excluded for non-support). */
  readonly notes: RequestNoteView[];
  /** The column-level audit trail (internal-note entries excluded for non-support). */
  readonly auditTrail: AuditEntryView[];
}

/** Raised when the request id does not exist. Mapped to 404 by the route layer. */
export class RequestNotFoundError extends Error {
  constructor(readonly requestId: number) {
    super(`Request ${requestId} not found`);
    this.name = 'RequestNotFoundError';
  }
}

/** Raised when the viewer may not view the request. Mapped to 403 (FORBIDDEN). */
export class RequestForbiddenError extends Error {
  constructor(readonly requestId: number) {
    super(`Not permitted to view request ${requestId}`);
    this.name = 'RequestForbiddenError';
  }
}

/** The narrow contract the route handler depends on. */
export interface RequestDetailStore {
  /**
   * Load the full detail for a request as seen by `viewer`, and record the
   * viewer's `last_seen` (R5.2). Assembles the request row, its pinned version
   * fields merged with values, its notes and its audit trail (R5.1, R17.4),
   * with internal notes and internal-note audit entries excluded for a
   * non-support viewer. Throws {@link RequestNotFoundError} for an unknown id
   * and {@link RequestForbiddenError} when the viewer may not view it.
   */
  getDetail(requestId: number, viewer: DetailViewer): Promise<RequestDetailView>;
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

interface DetailFieldDbRow {
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
  value: string | null;
}

interface NoteDbRow {
  id: string | number;
  author_id: string | number;
  is_internal: boolean;
  body: string;
  created_at: Date | string;
}

interface AuditDbRow {
  id: string | number;
  entity_type: string;
  entity_id: string | number;
  field_name: string;
  old_value: string | null;
  new_value: string | null;
  changed_by_id: string | number;
  changed_at: Date | string;
}

interface VisibilityDbRow {
  visible: boolean;
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

/**
 * Merge one field row into its detail view (R5.1, R3.5, R16.3). Name and data
 * type come from the data point; description/help text prefer the field
 * override; the dropdown option list is resolved through {@link resolveOptions}
 * (override else default) and only surfaced for DROPDOWN fields.
 */
function toFieldView(row: DetailFieldDbRow): RequestFieldView {
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
    value: row.value,
  };
}

function toNoteView(row: NoteDbRow): RequestNoteView {
  return {
    id: Number(row.id),
    authorId: Number(row.author_id),
    isInternal: row.is_internal,
    body: row.body,
    createdAt: toIso(row.created_at) as string,
  };
}

function toAuditView(row: AuditDbRow): AuditEntryView {
  return {
    id: Number(row.id),
    entityType: row.entity_type,
    entityId: Number(row.entity_id),
    fieldName: row.field_name,
    oldValue: row.old_value,
    newValue: row.new_value,
    changedById: Number(row.changed_by_id),
    changedAt: toIso(row.changed_at) as string,
  };
}

/**
 * A runner that executes `fn` inside a single database transaction. Production
 * uses {@link withTransaction}; tests inject a pass-through backed by a fake
 * {@link Queryable}. The detail read plus the `last_seen` upsert share one
 * transaction so a viewer's read-state moves atomically with the read.
 */
export type TransactionRunner = <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T>;

const defaultTransactionRunner: TransactionRunner = (fn) =>
  withTransaction((client) => fn(client));

/**
 * Postgres-backed {@link RequestDetailStore}. All SQL is parameterised. The
 * assembly reads plus the viewer's `last_seen` upsert share one transaction.
 */
export class DbRequestDetailStore implements RequestDetailStore {
  constructor(
    private readonly runTransaction: TransactionRunner = defaultTransactionRunner,
  ) {}

  async getDetail(
    requestId: number,
    viewer: DetailViewer,
  ): Promise<RequestDetailView> {
    return this.runTransaction(async (tx) => {
      // 1. Load the request header joined to its pinned version + task (R5.1).
      const header = await one<RequestHeaderDbRow>(
        `SELECT r.id                   AS id,
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
          WHERE r.id = $1`,
        [requestId],
        tx,
      );
      if (!header) {
        throw new RequestNotFoundError(requestId);
      }
      const teamId = Number(header.team_id);
      const raisedById = Number(header.raised_by_id);
      const versionId = Number(header.task_version_id);

      // Support-ness is resolved here, against the request's own team, so the
      // internal-note exclusion below applies BEFORE any internal content is
      // read (R5.1, R7.3). A viewer is a support viewer iff their team
      // memberships include this request's team.
      const isSupportViewer = viewer.teamsMemberOf.includes(teamId);

      // 2. Visibility check. The raiser and any support member of the team may
      //    always view; otherwise the viewer must be a manager somewhere in the
      //    raiser's upward hierarchy (R19 self-FK). The recursive CTE walks
      //    manager_id upward from the raiser with a depth guard so a malformed
      //    cycle still terminates.
      const isRaiser = raisedById === viewer.userId;
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
          [raisedById, viewer.userId],
          tx,
        );
        canView = vis?.visible === true;
      }
      if (!canView) {
        throw new RequestForbiddenError(requestId);
      }

      // 3. Load the pinned version's fields merged with their data points and
      //    LEFT JOINed to the entered value (R5.1). Ordered by field order.
      const fieldRows = await many<DetailFieldDbRow>(
        `SELECT tf.id                 AS task_field_id,
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
                dp.regexp_pattern     AS dp_regexp_pattern,
                rfv.value             AS value
           FROM task_field tf
           JOIN data_point dp ON dp.id = tf.data_point_id
           LEFT JOIN request_field_value rfv
                  ON rfv.task_field_id = tf.id
                 AND rfv.request_id = $2
          WHERE tf.task_version_id = $1
          ORDER BY tf.field_order ASC, tf.id ASC`,
        [versionId, requestId],
        tx,
      );

      // 4. Load the notes, oldest first. For a NON-support viewer, exclude
      //    internal notes at the query so they never leave the store (R5.1,
      //    R7.3). Support viewers see all notes.
      const noteRows = isSupportViewer
        ? await many<NoteDbRow>(
            `SELECT id, author_id, is_internal, body, created_at
               FROM request_note
              WHERE request_id = $1
              ORDER BY created_at ASC, id ASC`,
            [requestId],
            tx,
          )
        : await many<NoteDbRow>(
            `SELECT id, author_id, is_internal, body, created_at
               FROM request_note
              WHERE request_id = $1
                AND is_internal = false
              ORDER BY created_at ASC, id ASC`,
            [requestId],
            tx,
          );

      // 5. Load the audit trail: entries about the request itself, plus entries
      //    about this request's notes (R17.4). For a NON-support viewer, the
      //    note entries are restricted to NON-internal notes so no internal-note
      //    change is ever surfaced (R5.1, R17.4). Support viewers get all.
      const auditRows = isSupportViewer
        ? await many<AuditDbRow>(
            `SELECT id, entity_type, entity_id, field_name, old_value,
                    new_value, changed_by_id, changed_at
               FROM audit_entry
              WHERE (entity_type = 'request' AND entity_id = $1)
                 OR (entity_type = 'request_note'
                     AND entity_id IN (
                       SELECT id FROM request_note WHERE request_id = $1
                     ))
              ORDER BY changed_at ASC, id ASC`,
            [requestId],
            tx,
          )
        : await many<AuditDbRow>(
            `SELECT id, entity_type, entity_id, field_name, old_value,
                    new_value, changed_by_id, changed_at
               FROM audit_entry
              WHERE (entity_type = 'request' AND entity_id = $1)
                 OR (entity_type = 'request_note'
                     AND entity_id IN (
                       SELECT id FROM request_note
                        WHERE request_id = $1
                          AND is_internal = false
                     ))
              ORDER BY changed_at ASC, id ASC`,
            [requestId],
            tx,
          );

      // 6. Record the viewer's last-seen (R5.2), clearing their "Updated"
      //    indicator. Same upsert convention as the request-create store (6.3).
      await one<{ id: string | number }>(
        `INSERT INTO request_last_seen (request_id, user_id, last_seen_at)
         VALUES ($1, $2, now())
         ON CONFLICT (request_id, user_id)
         DO UPDATE SET last_seen_at = now(), updated_at = now()
         RETURNING id`,
        [requestId, viewer.userId],
        tx,
      );

      return {
        id: Number(header.id),
        taskReference: header.task_reference,
        taskVersionId: versionId,
        taskId: Number(header.task_id),
        taskName: header.task_name,
        versionNo: header.version_no,
        title: header.title,
        raisedById,
        teamId,
        assignedMemberId:
          header.assigned_member_id == null ? null : Number(header.assigned_member_id),
        status: header.status,
        jiraNumber: header.jira_number,
        estimatedStartDate: toIso(header.estimated_start_date),
        actualStartDate: toIso(header.actual_start_date),
        createdAt: toIso(header.created_at) as string,
        updatedAt: toIso(header.updated_at) as string,
        fields: fieldRows.map(toFieldView),
        notes: noteRows.map(toNoteView),
        auditTrail: auditRows.map(toAuditView),
      };
    });
  }
}
