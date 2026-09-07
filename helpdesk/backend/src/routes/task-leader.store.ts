import { one, many, withTransaction, type Queryable, type SqlParam } from '../db/query.js';
import { AuditWriter, type FieldChange } from '../audit/index.js';
import type { DataType } from '../validation/index.js';

/**
 * A runner that executes `fn` inside a single database transaction, passing the
 * enlisted queryable. Production uses {@link withTransaction} (a real `pg`
 * transaction); tests inject a runner backed by a fake {@link Queryable} so the
 * store's read/mutation/audit SQL is exercised without a live database.
 */
export type TransactionRunner = <T>(
  fn: (tx: Queryable) => Promise<T>,
) => Promise<T>;

/** The production transaction runner: a real `pg` transaction. */
const defaultTransactionRunner: TransactionRunner = (fn) =>
  withTransaction((client) => fn(client));

/**
 * Data-access layer for Team-Leader task management (design: "Administration"
 * — `POST/PATCH /api/team-leader/tasks` — create/new-version tasks; retire;
 * leader-only, R16, R20.4).
 *
 * ── Why an interface + a DB implementation ───────────────────────────────────
 * The route handlers (task-leader.routes.ts) depend on this narrow {@link
 * TaskLeaderStore} interface, never on `pg` directly, so they can be unit-tested
 * with an in-memory fake — matching the injectable style used by the team-admin,
 * team-leader and data-point routes. The production {@link DbTaskLeaderStore} is
 * the only place that talks to Postgres, and it does so exclusively through the
 * parameterised data-access layer (`db/query.ts`): every value travels as a
 * bound placeholder, nothing is interpolated into SQL text.
 *
 * ── Version pinning is the core rule (R16.4) ─────────────────────────────────
 * A task is versioned. {@link TaskLeaderStore.create} inserts the task, its
 * FIRST `task_version` (version 1) and a fresh set of `task_field` rows, then
 * points `task.current_version_id` at that version. {@link
 * TaskLeaderStore.createVersion} (an "edit") NEVER mutates the existing
 * `task_version`/`task_field` rows: it inserts a BRAND NEW version with its OWN
 * fresh `task_field` rows and re-points `current_version_id` at it. Requests
 * already raised against a prior version keep referencing that version's rows,
 * so their layout is preserved (R16.4). New requests get the latest version
 * (R16.5).
 *
 * ── Override restrictions (R16.3) ────────────────────────────────────────────
 * A `task_field` may override the data point's `description`/`help_text` and
 * (for DROPDOWN) its option list, but NEVER the data point's name or data type.
 * The schema (migration 0004) enforces this structurally — there are no
 * name/data_type override columns — and the route layer rejects any attempt to
 * supply them. Fields may only reference NON-RETIRED data points (R16.2); the
 * store checks this inside the transaction.
 *
 * ── Retirement (R16.6 / R20.4) ───────────────────────────────────────────────
 * {@link TaskLeaderStore.retire} flips `task.is_retired` to true; the row and
 * all its versions are never deleted. A retired task can't be chosen for new
 * requests (the New workflow filters it out) but stays associated with requests
 * already raised against it.
 *
 * ── Guards and audit are the store's job, in one transaction ─────────────────
 * Every mutation and its column-level audit rows (R17) share the SAME
 * transaction via {@link withTransaction} + the shared {@link AuditWriter}. A
 * failure aborts the whole transaction, so no partial task/version/field write
 * or orphan audit row is ever committed.
 */

/**
 * A single field on a task version, as supplied by the team leader (R16.2,
 * R16.3). Maps a NON-RETIRED data point into the version at a given order, with
 * optional description/help-text overrides and (DROPDOWN only) an options
 * override. There is deliberately NO name or data-type field — those are NOT
 * overridable (R16.3); they always come from the data point.
 */
export interface TaskFieldInput {
  readonly dataPointId: number;
  readonly fieldOrder: number;
  readonly isMandatory: boolean;
  readonly descriptionOverride: string | null;
  readonly helpTextOverride: string | null;
  /** DROPDOWN-only override of the data point's default option list (R3.5). */
  readonly optionsOverride: readonly string[] | null;
}

/** Fields accepted when creating a brand-new task with its first version (R16.1, R16.2). */
export interface CreateTaskInput {
  readonly teamId: number;
  readonly name: string;
  readonly supportNotes: string | null;
  readonly fields: readonly TaskFieldInput[];
}

/**
 * Fields accepted when editing an existing task — i.e. creating a NEW version
 * (R16.4). `name` (when present) renames the task itself; `supportNotes` and
 * `fields` populate the new version. A fresh `task_field` set is always written
 * for the new version, so prior versions are untouched (version pinning).
 */
export interface CreateVersionInput {
  readonly name?: string;
  readonly supportNotes: string | null;
  readonly fields: readonly TaskFieldInput[];
}

/** A field row as returned to the team-leader screen / New workflow. */
export interface TaskFieldView {
  readonly id: number;
  readonly dataPointId: number;
  readonly fieldOrder: number;
  readonly isMandatory: boolean;
  readonly descriptionOverride: string | null;
  readonly helpTextOverride: string | null;
  readonly optionsOverride: string[] | null;
}

/** A task version plus its ordered fields. */
export interface TaskVersionView {
  readonly id: number;
  readonly versionNo: number;
  readonly supportNotes: string | null;
  readonly fields: TaskFieldView[];
}

/** A task, its retirement flag, and its current (latest) version. */
export interface TaskView {
  readonly id: number;
  readonly teamId: number;
  readonly name: string;
  readonly isRetired: boolean;
  readonly currentVersion: TaskVersionView;
}

/** Raised when a task id does not exist. Mapped to 404 by the route layer. */
export class TaskNotFoundError extends Error {
  constructor(readonly taskId: number) {
    super(`Task ${taskId} not found`);
    this.name = 'TaskNotFoundError';
  }
}

/**
 * Raised when a supplied data point id is unknown or retired (R16.2). A retired
 * data point cannot be chosen for a new task definition or a new version. The
 * route layer maps this to `VALIDATION_FAILED`.
 */
export class RetiredDataPointError extends Error {
  constructor(readonly dataPointId: number, readonly reason: 'unknown' | 'retired') {
    super(
      reason === 'retired'
        ? `Data point ${dataPointId} is retired and cannot be used`
        : `Data point ${dataPointId} does not exist`,
    );
    this.name = 'RetiredDataPointError';
  }
}

/** The narrow contract the route handlers depend on. */
export interface TaskLeaderStore {
  /**
   * Resolve the team that owns a task (for the leader-only authorisation check
   * on edit/retire, R16.1). Returns `null` when the task does not exist.
   */
  findTeamIdForTask(taskId: number): Promise<number | null>;
  /**
   * Create a brand-new task with its first version and field set (R16.1, R16.2)
   * and point `current_version_id` at it. Throws {@link RetiredDataPointError}
   * when a field references an unknown/retired data point (R16.2). Returns the
   * created task with its current version.
   */
  create(input: CreateTaskInput, actingUserId: number): Promise<TaskView>;
  /**
   * Edit a task by creating a NEW version with a fresh field set (R16.4 —
   * version pinning). NEVER mutates prior versions/fields. Optionally renames
   * the task. Throws {@link TaskNotFoundError} for an unknown id and {@link
   * RetiredDataPointError} for an unknown/retired data point. Returns the task
   * with its new current version.
   */
  createVersion(
    taskId: number,
    input: CreateVersionInput,
    actingUserId: number,
  ): Promise<TaskView>;
  /**
   * Retire a task so it can't be chosen for new requests while remaining
   * associated with requests already raised against it (R16.6 / R20.4). Throws
   * {@link TaskNotFoundError} for an unknown id. Idempotent: retiring an
   * already-retired task is a no-op that still returns the task.
   */
  retire(taskId: number, actingUserId: number): Promise<TaskView>;
}

// ── DB row shapes ─────────────────────────────────────────────────────────────

interface TaskDbRow {
  id: string | number;
  team_id: string | number;
  name: string;
  is_retired: boolean;
  current_version_id: string | number | null;
}

interface TaskVersionDbRow {
  id: string | number;
  version_no: number;
  support_notes: string | null;
}

interface TaskFieldDbRow {
  id: string | number;
  data_point_id: string | number;
  field_order: number;
  is_mandatory: boolean;
  help_text_override: string | null;
  description_override: string | null;
  options_override: unknown;
}

interface DataPointStatusRow {
  id: string | number;
  is_retired: boolean;
}

// ── Row → view mappers ────────────────────────────────────────────────────────

function toTaskField(row: TaskFieldDbRow): TaskFieldView {
  return {
    id: Number(row.id),
    dataPointId: Number(row.data_point_id),
    fieldOrder: row.field_order,
    isMandatory: row.is_mandatory,
    descriptionOverride: row.description_override,
    helpTextOverride: row.help_text_override,
    optionsOverride:
      row.options_override == null
        ? null
        : (row.options_override as unknown[]).map((o) => String(o)),
  };
}

/**
 * Postgres-backed {@link TaskLeaderStore}. All SQL is parameterised; each task's
 * create/edit/retire mutation, its field writes, and their audit rows all share
 * one transaction.
 */
export class DbTaskLeaderStore implements TaskLeaderStore {
  constructor(
    private readonly audit: AuditWriter = new AuditWriter(),
    private readonly runTransaction: TransactionRunner = defaultTransactionRunner,
  ) {}

  async findTeamIdForTask(taskId: number): Promise<number | null> {
    // Routed through the transaction runner so the read uses the same queryable
    // seam as every other statement (and is exercised by the store tests). In
    // production this is a real single-statement transaction; the overhead is
    // negligible and it keeps the data-access seam uniform.
    return this.runTransaction(async (tx) => {
      const row = await one<{ team_id: string | number }>(
        `SELECT team_id FROM task WHERE id = $1`,
        [taskId],
        tx,
      );
      return row ? Number(row.team_id) : null;
    });
  }

  async create(input: CreateTaskInput, actingUserId: number): Promise<TaskView> {
    return this.runTransaction(async (tx) => {
      await assertDataPointsUsable(input.fields, tx);

      // 1. Insert the task (no current version yet — set after version 1 exists).
      const task = await one<TaskDbRow>(
        `INSERT INTO task (team_id, name)
         VALUES ($1, $2)
         RETURNING id, team_id, name, is_retired, current_version_id`,
        [input.teamId, input.name],
        tx,
      );
      if (!task) {
        throw new Error('INSERT INTO task produced no row');
      }
      const taskId = Number(task.id);

      // 2. Insert version 1 and its fresh field set.
      const version = await this.insertVersion(taskId, 1, input.supportNotes, input.fields, tx);

      // 3. Point the task at its first version (R16.5).
      await one<{ id: string | number }>(
        `UPDATE task SET current_version_id = $2, updated_at = now()
          WHERE id = $1
        RETURNING id`,
        [taskId, version.id],
        tx,
      );

      // 4. Column-level audit of the created task (first-set: null → value).
      await this.audit.record(
        { entityType: 'task', entityId: taskId, changedById: actingUserId },
        [
          { field: 'team_id', oldValue: null, newValue: input.teamId },
          { field: 'name', oldValue: null, newValue: input.name },
          { field: 'is_retired', oldValue: null, newValue: false },
          { field: 'current_version_id', oldValue: null, newValue: version.id },
        ],
        tx,
      );

      return {
        id: taskId,
        teamId: input.teamId,
        name: input.name,
        isRetired: false,
        currentVersion: version,
      };
    });
  }

  async createVersion(
    taskId: number,
    input: CreateVersionInput,
    actingUserId: number,
  ): Promise<TaskView> {
    return this.runTransaction(async (tx) => {
      // Lock the task row so a concurrent edit cannot assign the same next
      // version_no or race the current-version re-point.
      const current = await one<TaskDbRow>(
        `SELECT id, team_id, name, is_retired, current_version_id
           FROM task
          WHERE id = $1
          FOR UPDATE`,
        [taskId],
        tx,
      );
      if (!current) {
        throw new TaskNotFoundError(taskId);
      }

      await assertDataPointsUsable(input.fields, tx);

      // Next version number = current max for this task + 1. Editing NEVER
      // touches existing task_version/task_field rows — version pinning (R16.4).
      const maxRow = await one<{ max_no: number | null }>(
        `SELECT MAX(version_no) AS max_no FROM task_version WHERE task_id = $1`,
        [taskId],
        tx,
      );
      const nextVersionNo = (maxRow?.max_no ?? 0) + 1;

      const version = await this.insertVersion(
        taskId,
        nextVersionNo,
        input.supportNotes,
        input.fields,
        tx,
      );

      // Optionally rename the task; always re-point current_version_id at the
      // NEW version so new requests use the latest layout (R16.5).
      const nextName = input.name !== undefined ? input.name : current.name;
      await one<{ id: string | number }>(
        `UPDATE task
            SET name = $2, current_version_id = $3, updated_at = now()
          WHERE id = $1
        RETURNING id`,
        [taskId, nextName, version.id],
        tx,
      );

      // Column-level audit: the version re-point always, the name only if changed.
      const changes: FieldChange[] = [
        {
          field: 'current_version_id',
          oldValue: current.current_version_id == null ? null : Number(current.current_version_id),
          newValue: version.id,
        },
      ];
      if (nextName !== current.name) {
        changes.push({ field: 'name', oldValue: current.name, newValue: nextName });
      }
      await this.audit.record(
        { entityType: 'task', entityId: taskId, changedById: actingUserId },
        changes,
        tx,
      );

      return {
        id: taskId,
        teamId: Number(current.team_id),
        name: nextName,
        isRetired: current.is_retired,
        currentVersion: version,
      };
    });
  }

  async retire(taskId: number, actingUserId: number): Promise<TaskView> {
    return this.runTransaction(async (tx) => {
      const current = await one<TaskDbRow>(
        `SELECT id, team_id, name, is_retired, current_version_id
           FROM task
          WHERE id = $1
          FOR UPDATE`,
        [taskId],
        tx,
      );
      if (!current) {
        throw new TaskNotFoundError(taskId);
      }

      // Idempotent: only mutate + audit when the flag actually flips (R16.6).
      if (!current.is_retired) {
        await one<{ id: string | number }>(
          `UPDATE task SET is_retired = true, updated_at = now()
            WHERE id = $1
          RETURNING id`,
          [taskId],
          tx,
        );
        await this.audit.record(
          { entityType: 'task', entityId: taskId, changedById: actingUserId },
          [{ field: 'is_retired', oldValue: false, newValue: true }],
          tx,
        );
      }

      const version = await this.loadCurrentVersion(current, tx);
      return {
        id: taskId,
        teamId: Number(current.team_id),
        name: current.name,
        isRetired: true,
        currentVersion: version,
      };
    });
  }

  /**
   * Insert a `task_version` and its fresh set of `task_field` rows, returning
   * the new version with its ordered fields. Each field's `options_override` is
   * bound as JSON cast to jsonb (null stays null). Never touches other versions.
   */
  private async insertVersion(
    taskId: number,
    versionNo: number,
    supportNotes: string | null,
    fields: readonly TaskFieldInput[],
    tx: Queryable,
  ): Promise<TaskVersionView> {
    const versionRow = await one<TaskVersionDbRow>(
      `INSERT INTO task_version (task_id, version_no, support_notes)
       VALUES ($1, $2, $3)
       RETURNING id, version_no, support_notes`,
      [taskId, versionNo, supportNotes],
      tx,
    );
    if (!versionRow) {
      throw new Error('INSERT INTO task_version produced no row');
    }
    const versionId = Number(versionRow.id);

    const fieldViews: TaskFieldView[] = [];
    for (const field of fields) {
      const optionsParam: SqlParam =
        field.optionsOverride == null ? null : JSON.stringify(field.optionsOverride);
      const fieldRow = await one<TaskFieldDbRow>(
        `INSERT INTO task_field
           (task_version_id, data_point_id, field_order, is_mandatory,
            help_text_override, description_override, options_override)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         RETURNING id, data_point_id, field_order, is_mandatory,
                   help_text_override, description_override, options_override`,
        [
          versionId,
          field.dataPointId,
          field.fieldOrder,
          field.isMandatory,
          field.helpTextOverride,
          field.descriptionOverride,
          optionsParam,
        ],
        tx,
      );
      if (!fieldRow) {
        throw new Error('INSERT INTO task_field produced no row');
      }
      fieldViews.push(toTaskField(fieldRow));
    }

    return {
      id: versionId,
      versionNo: versionRow.version_no,
      supportNotes: versionRow.support_notes,
      fields: fieldViews,
    };
  }

  /** Load a task's current version (with fields) for the retire response. */
  private async loadCurrentVersion(
    task: TaskDbRow,
    tx: Queryable,
  ): Promise<TaskVersionView> {
    const versionRow = await one<TaskVersionDbRow>(
      `SELECT id, version_no, support_notes
         FROM task_version
        WHERE id = $1`,
      [task.current_version_id],
      tx,
    );
    if (!versionRow) {
      // A task always has a current version once created; defensive fallback.
      return { id: 0, versionNo: 0, supportNotes: null, fields: [] };
    }
    const fieldRows = await many<TaskFieldDbRow>(
      `SELECT id, data_point_id, field_order, is_mandatory,
              help_text_override, description_override, options_override
         FROM task_field
        WHERE task_version_id = $1
        ORDER BY field_order ASC, id ASC`,
      [versionRow.id],
      tx,
    );
    return {
      id: Number(versionRow.id),
      versionNo: versionRow.version_no,
      supportNotes: versionRow.support_notes,
      fields: fieldRows.map(toTaskField),
    };
  }
}

/**
 * Verify every field references a KNOWN, NON-RETIRED data point (R16.2). Reads
 * the status of all referenced ids in one bound query (the id list travels as a
 * parameter array, so nothing is interpolated). Throws {@link
 * RetiredDataPointError} on the first offending id. An empty field list is a
 * no-op (a task with no fields is allowed).
 */
async function assertDataPointsUsable(
  fields: readonly TaskFieldInput[],
  db: Queryable,
): Promise<void> {
  if (fields.length === 0) {
    return;
  }
  const ids = [...new Set(fields.map((f) => f.dataPointId))];
  const rows = await many<DataPointStatusRow>(
    `SELECT id, is_retired FROM data_point WHERE id = ANY($1::bigint[])`,
    [ids],
    db,
  );
  const byId = new Map<number, boolean>();
  for (const row of rows) {
    byId.set(Number(row.id), row.is_retired);
  }
  for (const id of ids) {
    if (!byId.has(id)) {
      throw new RetiredDataPointError(id, 'unknown');
    }
    if (byId.get(id) === true) {
      throw new RetiredDataPointError(id, 'retired');
    }
  }
}

/** Re-export for callers that need the field data-type union without a second import. */
export type { DataType };
