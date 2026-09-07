import { Router, type RequestHandler } from 'express';
import type { PoolClient } from 'pg';
import { ApiError } from '../middleware/errors.js';
import { requireAdmin } from '../middleware/authorize.js';
import { withTransaction } from '../db/query.js';
import { AuditWriter, type FieldChange } from '../audit/index.js';
import { isDataType, type DataType } from '../validation/index.js';
import {
  DbDataPointStore,
  type DataPoint,
  type DataPointStore,
  type NewDataPoint,
} from '../admin/data-point-store.js';

/**
 * Data point administration routes (design: "Administration —
 * POST/GET/PATCH /api/admin/data-points", R14, R20.4).
 *
 * ── Endpoints ────────────────────────────────────────────────────────────────
 *   POST  /api/admin/data-points      create a data point (R14.2)
 *   GET   /api/admin/data-points      list every data point (R14.1)
 *   PATCH /api/admin/data-points/:id  retire a data point (R14.3, R14.4)
 *
 * ── AuthZ ────────────────────────────────────────────────────────────────────
 * Every endpoint is administrator-only. The router mounts {@link requireAdmin}
 * ahead of the handlers, so a non-administrator is rejected with `FORBIDDEN`
 * (403) before any handler runs (R1.8, R13.1) — the frontend hiding the tiles
 * is UX only.
 *
 * ── Retirement rules (R14.4, R20.4) ──────────────────────────────────────────
 * Retiring flips `is_retired` to true; the row is never deleted. New task
 * definitions filter retired data points out of their pickable set (task 5.4),
 * while task versions already referencing the data point keep resolving it —
 * so historical requests and versions stay intact.
 *
 * ── Validation & audit ───────────────────────────────────────────────────────
 * Create bodies are validated HERE (name/type required; regexp needs a pattern;
 * dropdown needs a non-empty option list) and rejected with the uniform
 * `VALIDATION_FAILED` envelope. Each mutation and its column-level audit rows
 * share ONE transaction via {@link withTransaction}, so they commit or roll
 * back together (R17.1).
 *
 * Dependencies are injected so the handlers unit-test against fakes with no
 * database; {@link adminDataPointRouter}-style production wiring uses the real
 * Postgres-backed store and audit writer.
 */

/** The public JSON shape of a data point returned by the API. */
export interface DataPointView {
  readonly id: number;
  readonly name: string;
  readonly dataType: DataType;
  readonly description: string | null;
  readonly defaultHelpText: string | null;
  readonly regexpPattern: string | null;
  readonly defaultOptions: string[] | null;
  readonly isRetired: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Serialise a stored {@link DataPoint} to its public JSON view (dates ISO-8601). */
export function serializeDataPoint(dp: DataPoint): DataPointView {
  return {
    id: dp.id,
    name: dp.name,
    dataType: dp.dataType,
    description: dp.description,
    defaultHelpText: dp.defaultHelpText,
    regexpPattern: dp.regexpPattern,
    defaultOptions: dp.defaultOptions,
    isRetired: dp.isRetired,
    createdAt: dp.createdAt.toISOString(),
    updatedAt: dp.updatedAt.toISOString(),
  };
}

/** Read a required non-empty string field from the body, else VALIDATION_FAILED. */
function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw ApiError.of('VALIDATION_FAILED', `"${key}" is required.`);
  }
  return value.trim();
}

/** Read an optional string field: absent/null → null, non-string → VALIDATION_FAILED. */
function readOptionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value == null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw ApiError.of('VALIDATION_FAILED', `"${key}" must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Validate and normalise a create-data-point body into a {@link NewDataPoint}
 * (R14.2). Enforces the type-specific shape:
 *   - `name` and `dataType` are required; `dataType` must be one of the nine.
 *   - REGEXP requires a non-empty `regexpPattern` that compiles as a RegExp.
 *   - DROPDOWN requires a non-empty `defaultOptions` array of non-empty strings.
 *   - For non-REGEXP/DROPDOWN types the pattern/options are ignored (stored null)
 *     so a data point never carries shape it cannot use.
 */
export function parseCreateBody(body: unknown): NewDataPoint {
  const record = (body ?? {}) as Record<string, unknown>;

  const name = readRequiredString(record, 'name');
  const dataTypeRaw = record['dataType'];
  if (!isDataType(dataTypeRaw)) {
    throw ApiError.of('VALIDATION_FAILED', '"dataType" must be a supported data type.');
  }
  const dataType: DataType = dataTypeRaw;
  const description = readOptionalString(record, 'description');
  const defaultHelpText = readOptionalString(record, 'defaultHelpText');

  let regexpPattern: string | null = null;
  let defaultOptions: string[] | null = null;

  if (dataType === 'REGEXP') {
    regexpPattern = readRequiredString(record, 'regexpPattern');
    try {
      // eslint-disable-next-line no-new
      new RegExp(regexpPattern);
    } catch {
      throw ApiError.of('VALIDATION_FAILED', '"regexpPattern" is not a valid regular expression.');
    }
  } else if (dataType === 'DROPDOWN') {
    const raw = record['defaultOptions'];
    if (!Array.isArray(raw) || raw.length === 0) {
      throw ApiError.of(
        'VALIDATION_FAILED',
        '"defaultOptions" must be a non-empty array for a DROPDOWN data point.',
      );
    }
    const options: string[] = [];
    for (const opt of raw) {
      if (typeof opt !== 'string' || opt.trim() === '') {
        throw ApiError.of('VALIDATION_FAILED', '"defaultOptions" must contain non-empty strings.');
      }
      options.push(opt.trim());
    }
    defaultOptions = options;
  }

  return { name, dataType, description, defaultHelpText, regexpPattern, defaultOptions };
}

/** Parse a positive-integer id from a route param, else VALIDATION_FAILED. */
function parseId(raw: unknown): number {
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const id = Number(raw);
    if (Number.isSafeInteger(id) && id > 0) {
      return id;
    }
  }
  throw ApiError.of('VALIDATION_FAILED', 'A valid data point id is required.');
}

/**
 * Runs a unit of work inside a single transaction, passing the transaction
 * client to the callback. Injected so handlers unit-test without a live pool;
 * production wiring uses {@link withTransaction}, which shares one transaction
 * between the mutation and its audit rows (R17.1).
 */
export type TransactionRunner = <T>(fn: (tx: PoolClient) => Promise<T>) => Promise<T>;

/** `POST /api/admin/data-points` — create a data point (R14.2). */
export function createDataPointCreateHandler(
  store: DataPointStore,
  audit: AuditWriter,
  runInTransaction: TransactionRunner = withTransaction,
): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const input = parseCreateBody(req.body);
      const changedById = req.currentUser!.id;
      const created = await runInTransaction(async (tx) => {
        const dp = await store.create(input, tx);
        // Audit the creation column-by-column: every populated field goes from
        // absent (null) to its new value (R17.1, R17.2).
        const changes: FieldChange[] = [
          { field: 'name', oldValue: null, newValue: dp.name },
          { field: 'data_type', oldValue: null, newValue: dp.dataType },
          { field: 'description', oldValue: null, newValue: dp.description },
          { field: 'default_help_text', oldValue: null, newValue: dp.defaultHelpText },
          { field: 'regexp_pattern', oldValue: null, newValue: dp.regexpPattern },
          {
            field: 'default_options',
            oldValue: null,
            newValue: dp.defaultOptions == null ? null : JSON.stringify(dp.defaultOptions),
          },
          { field: 'is_retired', oldValue: null, newValue: dp.isRetired },
        ];
        await audit.record(
          { entityType: 'data_point', entityId: dp.id, changedById },
          changes,
          tx,
        );
        return dp;
      });
      res.status(201).json(serializeDataPoint(created));
    })().catch(next);
  };
}

/** `GET /api/admin/data-points` — list every data point (R14.1). */
export function createDataPointListHandler(store: DataPointStore): RequestHandler {
  return (_req, res, next) => {
    void (async () => {
      const points = await store.list();
      res.status(200).json({ dataPoints: points.map(serializeDataPoint) });
    })().catch(next);
  };
}

/**
 * `PATCH /api/admin/data-points/:id` — retire a data point (R14.3, R14.4).
 *
 * A missing data point is a 404 NOT_FOUND. Retiring an already-retired point is
 * idempotent (no audit row is written because nothing changed). Otherwise the
 * `is_retired` false→true change is audited in the same transaction (R17.1).
 */
export function createDataPointRetireHandler(
  store: DataPointStore,
  audit: AuditWriter,
  runInTransaction: TransactionRunner = withTransaction,
): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const id = parseId(req.params['id']);
      const changedById = req.currentUser!.id;
      const updated = await runInTransaction(async (tx) => {
        const before = await store.findById(id, tx);
        if (!before) {
          return null;
        }
        const wasRetired = before.isRetired;
        const dp = await store.retire(id, tx);
        if (dp && !wasRetired) {
          await audit.record(
            { entityType: 'data_point', entityId: id, changedById },
            [{ field: 'is_retired', oldValue: false, newValue: true }],
            tx,
          );
        }
        return dp;
      });
      if (!updated) {
        throw new ApiError(404, 'NOT_FOUND', 'Data point not found.');
      }
      res.status(200).json(serializeDataPoint(updated));
    })().catch(next);
  };
}

/** Dependencies for {@link createDataPointRouter}; each defaults to a real impl. */
export interface DataPointRouterDeps {
  readonly store: DataPointStore;
  readonly audit: AuditWriter;
  /** Transaction runner; defaults to {@link withTransaction}. Injectable for tests. */
  readonly runInTransaction?: TransactionRunner;
}

/**
 * Build the data point admin router, mounted under `/admin/data-points`. Every
 * route is administrator-only via {@link requireAdmin}. Handlers and store are
 * injected so the router can be built against fakes in tests.
 */
export function createDataPointRouter(deps: DataPointRouterDeps): Router {
  const router = Router();
  const { store, audit } = deps;
  const runInTransaction = deps.runInTransaction ?? withTransaction;

  router.post('/', requireAdmin, createDataPointCreateHandler(store, audit, runInTransaction));
  router.get('/', requireAdmin, createDataPointListHandler(store));
  router.patch('/:id', requireAdmin, createDataPointRetireHandler(store, audit, runInTransaction));

  return router;
}

/** Production data point router, wired to the Postgres-backed store and audit writer. */
export const dataPointRouter: Router = createDataPointRouter({
  store: new DbDataPointStore(),
  audit: new AuditWriter(),
});
