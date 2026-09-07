import { one, many, type Queryable } from '../db/query.js';
import { pool } from '../db/pool.js';
import { resolveOptions, type DataType } from '../validation/index.js';

/**
 * Data-access layer for the New-workflow SUPPORT read endpoints (design:
 * "Workflow support" — `GET /api/teams?open=true`,
 * `GET /api/teams/{id}/tasks?active=true`,
 * `GET /api/tasks/{id}/current-version`, R2.3, R2.5–2.8, R3.5).
 *
 * ── Why an interface + a DB implementation ───────────────────────────────────
 * The route handlers (workflow-support.routes.ts) depend on this narrow
 * {@link WorkflowSupportStore} interface, never on `pg` directly, so they can be
 * unit-tested with an in-memory fake — matching the injectable style used by the
 * team-admin, team-leader, task-leader and data-point stores. The production
 * {@link DbWorkflowSupportStore} is the only place that talks to Postgres, and
 * it does so exclusively through the parameterised data-access layer
 * (`db/query.ts`): every value travels as a bound placeholder, nothing is
 * interpolated into SQL text.
 *
 * ── What these reads power ───────────────────────────────────────────────────
 * Step 1 of the New workflow needs the teams a user may raise against (only
 * NON-CLOSED teams, R2.3/R13.4) and, once a team is chosen, that team's
 * selectable tasks (only NON-RETIRED tasks, R2.3/R16.6). Step 2 needs the
 * chosen task's CURRENT (latest) version laid out for data entry (R16.5): every
 * field in order, with its data type, help text, mandatory flag, and — for a
 * dropdown — its effective option list (R2.5–2.8, R3.5).
 *
 * ── The field merge (R3.5, R16.3) ────────────────────────────────────────────
 * A task field carries the data point it maps plus optional overrides. The
 * NAME and DATA TYPE always come from the data point and are NEVER overridable
 * (R16.3); DESCRIPTION and HELP TEXT come from the field's override when set,
 * otherwise the data point's default; and the DROPDOWN option list is the
 * task-level override where provided, otherwise the data point's default list
 * (R3.5) — resolved through the shared {@link resolveOptions} so the workflow
 * and the validator agree on the effective list.
 *
 * These are read-only: there is no mutation and therefore no transaction/audit.
 */

/** A non-closed team offered on New-workflow Step 1 (R2.3). */
export interface OpenTeamView {
  readonly id: number;
  readonly title: string;
  readonly description: string | null;
}

/** A non-retired task offered for a chosen team on New-workflow Step 1 (R2.3). */
export interface ActiveTaskView {
  readonly id: number;
  readonly teamId: number;
  readonly name: string;
}

/**
 * One field of a task's current version, fully merged for data entry
 * (R2.5–2.8, R3.5). `name` and `dataType` always come from the data point
 * (never overridable, R16.3); `description`/`helpText` prefer the field's
 * override and fall back to the data point default; `options` is the effective
 * dropdown list (override where present, else default); `regexpPattern` is the
 * data point's pattern for REGEXP fields.
 */
export interface CurrentVersionFieldView {
  /** The task_field id (identifies the field within this version). */
  readonly taskFieldId: number;
  /** The underlying data point id. */
  readonly dataPointId: number;
  /** Display order within the version (ascending). */
  readonly fieldOrder: number;
  /** Field label — always the data point name (not overridable, R16.3). */
  readonly name: string;
  /** Field data type — always the data point type (not overridable, R16.3). */
  readonly dataType: DataType;
  /** Whether the field must be completed (R2.5, R3.6). */
  readonly isMandatory: boolean;
  /** Description: field override, else data point default (may be null). */
  readonly description: string | null;
  /** "?" help text: field override, else data point default (may be null, R2.6). */
  readonly helpText: string | null;
  /** DROPDOWN effective option list (override else default, R3.5); null otherwise. */
  readonly options: string[] | null;
  /** REGEXP validation pattern from the data point (R3.4); null otherwise. */
  readonly regexpPattern: string | null;
}

/**
 * A task's current (latest) version laid out for New-workflow Step 2 (R16.5).
 * Fields are ordered by {@link CurrentVersionFieldView.fieldOrder}.
 */
export interface CurrentVersionView {
  readonly taskId: number;
  readonly taskName: string;
  readonly teamId: number;
  readonly versionId: number;
  readonly versionNo: number;
  /** Support notes for this version (shown to support via "Help", R16.7). */
  readonly supportNotes: string | null;
  readonly fields: CurrentVersionFieldView[];
}

/** Raised when a task id does not exist. Mapped to 404 by the route layer. */
export class TaskNotFoundError extends Error {
  constructor(readonly taskId: number) {
    super(`Task ${taskId} not found`);
    this.name = 'TaskNotFoundError';
  }
}

/** The narrow contract the route handlers depend on. */
export interface WorkflowSupportStore {
  /** List every NON-CLOSED team for Step 1's team drop-down (R2.3, R13.4). */
  listOpenTeams(): Promise<OpenTeamView[]>;
  /**
   * List a team's NON-RETIRED tasks for Step 1's task selection (R2.3, R16.6).
   * An unknown/closed team simply yields an empty list — no task is selectable.
   */
  listActiveTasks(teamId: number): Promise<ActiveTaskView[]>;
  /**
   * Return the task's CURRENT (latest) version laid out for data entry
   * (R16.5, R2.5–2.8, R3.5): fields in order, each merged with its data point.
   * Throws {@link TaskNotFoundError} when the task does not exist.
   */
  getCurrentVersion(taskId: number): Promise<CurrentVersionView>;
}

// ── DB row shapes ─────────────────────────────────────────────────────────────

interface OpenTeamDbRow {
  id: string | number;
  title: string;
  description: string | null;
}

interface ActiveTaskDbRow {
  id: string | number;
  team_id: string | number;
  name: string;
}

/** The task + its current version header (one row, or none when the task is absent). */
interface CurrentVersionHeaderDbRow {
  task_id: string | number;
  task_name: string;
  team_id: string | number;
  version_id: string | number;
  version_no: number;
  support_notes: string | null;
}

/**
 * A task_field joined to its data_point: the field supplies order, mandatory
 * flag and the overrides; the data point supplies the (non-overridable) name
 * and data type, plus the fallbacks for description/help text/options/regexp.
 */
interface CurrentVersionFieldDbRow {
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

// ── Row → view mappers ────────────────────────────────────────────────────────

/** Normalise a JSONB option column into a string[] or null. */
function toOptionArray(value: unknown): string[] | null {
  if (value == null) {
    return null;
  }
  return (value as unknown[]).map((o) => String(o));
}

/**
 * Merge one field row into its entry view (R2.5–2.8, R3.5, R16.3). Name and
 * data type come from the data point; description/help text prefer the field
 * override; the dropdown option list is resolved through {@link resolveOptions}
 * (override else default) — and only surfaced for DROPDOWN fields so other
 * types report `options: null`.
 */
function toFieldView(row: CurrentVersionFieldDbRow): CurrentVersionFieldView {
  const optionsOverride = toOptionArray(row.options_override);
  const defaultOptions = toOptionArray(row.dp_default_options);

  let options: string[] | null = null;
  if (row.dp_data_type === 'DROPDOWN') {
    // Share the validator's precedence so the workflow and validation agree on
    // the effective option list (task-level override else data point default).
    options = [...resolveOptions({
      dataType: row.dp_data_type,
      isMandatory: row.is_mandatory,
      optionsOverride,
      defaultOptions,
    })];
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
  };
}

/**
 * Postgres-backed {@link WorkflowSupportStore}. All SQL is parameterised and
 * read-only. The `db` seam defaults to the shared pool; tests inject a fake.
 */
export class DbWorkflowSupportStore implements WorkflowSupportStore {
  constructor(private readonly db: Queryable = pool) {}

  async listOpenTeams(): Promise<OpenTeamView[]> {
    const rows = await many<OpenTeamDbRow>(
      `SELECT id, title, description
         FROM team
        WHERE is_closed = false
        ORDER BY title ASC, id ASC`,
      [],
      this.db,
    );
    return rows.map((row) => ({
      id: Number(row.id),
      title: row.title,
      description: row.description,
    }));
  }

  async listActiveTasks(teamId: number): Promise<ActiveTaskView[]> {
    const rows = await many<ActiveTaskDbRow>(
      `SELECT id, team_id, name
         FROM task
        WHERE team_id = $1
          AND is_retired = false
        ORDER BY name ASC, id ASC`,
      [teamId],
      this.db,
    );
    return rows.map((row) => ({
      id: Number(row.id),
      teamId: Number(row.team_id),
      name: row.name,
    }));
  }

  async getCurrentVersion(taskId: number): Promise<CurrentVersionView> {
    // Resolve the task and its CURRENT version header in one bound query. A task
    // always has a current_version_id once created (task-leader.store sets it),
    // so the INNER JOIN to task_version yields the latest version (R16.5).
    const header = await one<CurrentVersionHeaderDbRow>(
      `SELECT t.id           AS task_id,
              t.name         AS task_name,
              t.team_id      AS team_id,
              tv.id          AS version_id,
              tv.version_no  AS version_no,
              tv.support_notes AS support_notes
         FROM task t
         JOIN task_version tv ON tv.id = t.current_version_id
        WHERE t.id = $1`,
      [taskId],
      this.db,
    );
    if (!header) {
      throw new TaskNotFoundError(taskId);
    }
    const versionId = Number(header.version_id);

    // Fetch the version's fields joined to their data points, in field order.
    // The data point owns name/data_type (non-overridable, R16.3) and the
    // description/help/options/regexp fallbacks; the task_field owns the order,
    // mandatory flag and any overrides.
    const fieldRows = await many<CurrentVersionFieldDbRow>(
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
              dp.regexp_pattern     AS dp_regexp_pattern
         FROM task_field tf
         JOIN data_point dp ON dp.id = tf.data_point_id
        WHERE tf.task_version_id = $1
        ORDER BY tf.field_order ASC, tf.id ASC`,
      [versionId],
      this.db,
    );

    return {
      taskId: Number(header.task_id),
      taskName: header.task_name,
      teamId: Number(header.team_id),
      versionId,
      versionNo: header.version_no,
      supportNotes: header.support_notes,
      fields: fieldRows.map(toFieldView),
    };
  }
}
