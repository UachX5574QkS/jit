import type { Queryable, SqlParam } from '../db/query.js';
import { one, query } from '../db/query.js';
import { pool } from '../db/pool.js';
import { DATA_TYPES, type DataType } from '../validation/index.js';

/**
 * Data-access for the data point catalogue (design: "Administration —
 * POST/GET/PATCH /api/admin/data-points", R14, R20.4).
 *
 * ── What a data point is ─────────────────────────────────────────────────────
 * A reusable field definition maintained by administrators: a name, a data
 * type (the closed `data_point_type` enum, migration 0004), an admin-facing
 * description, the default "?" help text, and — where the type calls for it —
 * a REGEXP `regexp_pattern` or a DROPDOWN `default_options` list (R14.2). A
 * data point can be RETIRED, which stops it being chosen for NEW task
 * definitions while leaving it operational for task versions already using it
 * (R14.3, R14.4, R20.4). Retirement is a flag flip on the row — retired rows
 * are never deleted, so historical task versions keep resolving their fields.
 *
 * ── SQL safety ───────────────────────────────────────────────────────────────
 * Every statement goes through the parameterised {@link query} layer with bound
 * placeholders; no value is ever interpolated into SQL text. The `db` seam lets
 * a mutation and its audit write share one transaction (see the route handlers).
 */

/** The nine supported data point types, re-exported for callers of this module. */
export { DATA_TYPES };
export type { DataType };

/** A data point row as stored, with JS-friendly field names. */
export interface DataPoint {
  readonly id: number;
  readonly name: string;
  readonly dataType: DataType;
  readonly description: string | null;
  readonly defaultHelpText: string | null;
  /** REGEXP-only validation pattern (R3.4); null for other types. */
  readonly regexpPattern: string | null;
  /** DROPDOWN-only default option list (R3.5); null for other types. */
  readonly defaultOptions: string[] | null;
  /** Retired data points cannot be chosen for new task definitions (R14.4). */
  readonly isRetired: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The fields needed to create a data point (surrogate id + timestamps are assigned by the DB). */
export interface NewDataPoint {
  readonly name: string;
  readonly dataType: DataType;
  readonly description: string | null;
  readonly defaultHelpText: string | null;
  readonly regexpPattern: string | null;
  readonly defaultOptions: string[] | null;
}

/**
 * The data point store seam. Injectable so route handlers can be unit-tested
 * against an in-memory fake; production wiring uses {@link DbDataPointStore}.
 */
export interface DataPointStore {
  /** Insert a new data point and return the stored row. */
  create(input: NewDataPoint, db?: Queryable): Promise<DataPoint>;
  /** List every data point (retired ones included), newest name order. */
  list(db?: Queryable): Promise<DataPoint[]>;
  /** Load one data point by id, or null when it does not exist. */
  findById(id: number, db?: Queryable): Promise<DataPoint | null>;
  /**
   * Mark a data point retired and return the updated row, or null when no such
   * data point exists. Idempotent: retiring an already-retired point is a no-op
   * that still returns the row.
   */
  retire(id: number, db?: Queryable): Promise<DataPoint | null>;
}

/** The column list selected for every read, in a fixed order. */
const COLUMNS = `
  id, name, data_type, description, default_help_text,
  regexp_pattern, default_options, is_retired, created_at, updated_at
`;

/** A raw DB row before mapping to the {@link DataPoint} shape. */
interface DataPointRow {
  id: string | number;
  name: string;
  data_type: DataType;
  description: string | null;
  default_help_text: string | null;
  regexp_pattern: string | null;
  default_options: unknown;
  is_retired: boolean;
  created_at: Date;
  updated_at: Date;
}

/** Map a raw DB row to the JS-friendly {@link DataPoint}. */
function mapRow(row: DataPointRow): DataPoint {
  return {
    id: Number(row.id),
    name: row.name,
    dataType: row.data_type,
    description: row.description,
    defaultHelpText: row.default_help_text,
    regexpPattern: row.regexp_pattern,
    // `default_options` is JSONB; `pg` returns it already parsed. Normalise the
    // absent case to null and anything else to a string array.
    defaultOptions:
      row.default_options == null
        ? null
        : (row.default_options as unknown[]).map((o) => String(o)),
    isRetired: row.is_retired,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Postgres-backed {@link DataPointStore}. */
export class DbDataPointStore implements DataPointStore {
  constructor(private readonly db: Queryable = pool) {}

  async create(input: NewDataPoint, db: Queryable = this.db): Promise<DataPoint> {
    // default_options is bound as a JSON string cast to jsonb; null stays null.
    const optionsParam: SqlParam =
      input.defaultOptions == null ? null : JSON.stringify(input.defaultOptions);
    const row = await one<DataPointRow>(
      `INSERT INTO data_point
         (name, data_type, description, default_help_text,
          regexp_pattern, default_options)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING ${COLUMNS}`,
      [
        input.name,
        input.dataType,
        input.description,
        input.defaultHelpText,
        input.regexpPattern,
        optionsParam,
      ],
      db,
    );
    // INSERT ... RETURNING always yields exactly one row.
    return mapRow(row as DataPointRow);
  }

  async list(db: Queryable = this.db): Promise<DataPoint[]> {
    const rows = await query<DataPointRow>(
      `SELECT ${COLUMNS} FROM data_point ORDER BY name ASC, id ASC`,
      [],
      db,
    );
    return rows.map(mapRow);
  }

  async findById(id: number, db: Queryable = this.db): Promise<DataPoint | null> {
    const row = await one<DataPointRow>(
      `SELECT ${COLUMNS} FROM data_point WHERE id = $1`,
      [id],
      db,
    );
    return row ? mapRow(row) : null;
  }

  async retire(id: number, db: Queryable = this.db): Promise<DataPoint | null> {
    const row = await one<DataPointRow>(
      `UPDATE data_point
          SET is_retired = true, updated_at = now()
        WHERE id = $1
      RETURNING ${COLUMNS}`,
      [id],
      db,
    );
    return row ? mapRow(row) : null;
  }
}
