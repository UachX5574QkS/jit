import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import type { PoolClient } from 'pg';
import {
  createDataPointCreateHandler,
  createDataPointListHandler,
  createDataPointRetireHandler,
  parseCreateBody,
  serializeDataPoint,
  type TransactionRunner,
} from './data-points.routes.js';
import { AuditWriter, type AuditContext, type FieldChange } from '../audit/index.js';
import { ApiError } from '../middleware/errors.js';
import type { Queryable } from '../db/query.js';
import type {
  DataPoint,
  DataPointStore,
  NewDataPoint,
} from '../admin/data-point-store.js';

/**
 * Tests for the data point admin endpoints (design: "Administration —
 * POST/GET/PATCH /api/admin/data-points", R14, R20.4). Handlers are invoked
 * directly with fake req/res/next — no HTTP server, no database — matching the
 * project's injectable, DB-free unit-test style. The store, audit writer, and
 * transaction runner are in-memory fakes so the create/list/retire behaviour
 * and its audit writes are exercised without touching Postgres.
 */

/** An in-memory {@link DataPointStore} with auto-incrementing ids. */
class FakeDataPointStore implements DataPointStore {
  private seq = 0;
  readonly rows = new Map<number, DataPoint>();

  async create(input: NewDataPoint): Promise<DataPoint> {
    const id = ++this.seq;
    const now = new Date('2026-01-01T00:00:00.000Z');
    const dp: DataPoint = {
      id,
      name: input.name,
      dataType: input.dataType,
      description: input.description,
      defaultHelpText: input.defaultHelpText,
      regexpPattern: input.regexpPattern,
      defaultOptions: input.defaultOptions,
      isRetired: false,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(id, dp);
    return dp;
  }

  async list(): Promise<DataPoint[]> {
    return [...this.rows.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async findById(id: number): Promise<DataPoint | null> {
    return this.rows.get(id) ?? null;
  }

  async retire(id: number): Promise<DataPoint | null> {
    const dp = this.rows.get(id);
    if (!dp) {
      return null;
    }
    const updated: DataPoint = { ...dp, isRetired: true, updatedAt: new Date() };
    this.rows.set(id, updated);
    return updated;
  }
}

/** An audit writer that records the calls it receives instead of hitting the DB. */
class RecordingAuditWriter extends AuditWriter {
  readonly calls: Array<{ ctx: AuditContext; changes: FieldChange[] }> = [];
  override async record(
    ctx: AuditContext,
    changes: readonly FieldChange[],
    _db?: Queryable,
  ): Promise<number> {
    this.calls.push({ ctx, changes: [...changes] });
    return changes.length;
  }
}

/** A transaction runner that just runs the callback with a dummy client (no DB). */
const fakeTx: TransactionRunner = async (fn) => fn({} as PoolClient);

/** A minimal fake response recording status and JSON body. */
interface FakeRes {
  statusCode?: number;
  body?: unknown;
  res: Response;
  onDone?: () => void;
}

function fakeResponse(): FakeRes {
  const state: FakeRes = { res: undefined as unknown as Response };
  state.res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      state.onDone?.();
      return this;
    },
  } as unknown as Response;
  return state;
}

/** Invoke a handler, settling on `next(err)` or a terminal `json()`. */
function invoke(
  handler: (req: Request, res: Response, next: (err?: unknown) => void) => void,
  req: Partial<Request>,
  fake: FakeRes,
): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (err: unknown) => {
      if (!settled) {
        settled = true;
        resolve(err);
      }
    };
    fake.onDone = () => settle(undefined);
    handler(req as Request, fake.res, (err?: unknown) => settle(err));
  });
}

/** A request carrying an admin current user. */
function adminReq(overrides: Partial<Request> = {}): Partial<Request> {
  return {
    currentUser: { id: 7 } as Request['currentUser'],
    body: {},
    params: {},
    ...overrides,
  };
}

describe('parseCreateBody', () => {
  it('accepts a minimal TEXT data point (R14.2)', () => {
    const parsed = parseCreateBody({ name: '  Title ', dataType: 'TEXT' });
    assert.deepEqual(parsed, {
      name: 'Title',
      dataType: 'TEXT',
      description: null,
      defaultHelpText: null,
      regexpPattern: null,
      defaultOptions: null,
    });
  });

  it('requires a name', () => {
    assert.throws(() => parseCreateBody({ dataType: 'TEXT' }), (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.code, 'VALIDATION_FAILED');
      return true;
    });
  });

  it('rejects an unknown data type', () => {
    assert.throws(() => parseCreateBody({ name: 'X', dataType: 'PICTURE' }), (e) => {
      assert.ok(e instanceof ApiError);
      assert.equal((e as ApiError).code, 'VALIDATION_FAILED');
      return true;
    });
  });

  it('requires a valid regexp pattern for REGEXP', () => {
    // Missing pattern.
    assert.throws(() => parseCreateBody({ name: 'Ref', dataType: 'REGEXP' }), ApiError);
    // Unparseable pattern.
    assert.throws(
      () => parseCreateBody({ name: 'Ref', dataType: 'REGEXP', regexpPattern: '([' }),
      ApiError,
    );
    // Valid pattern captured.
    const ok = parseCreateBody({ name: 'Ref', dataType: 'REGEXP', regexpPattern: '^JIRA-\\d+$' });
    assert.equal(ok.regexpPattern, '^JIRA-\\d+$');
    assert.equal(ok.defaultOptions, null);
  });

  it('requires a non-empty options list for DROPDOWN', () => {
    assert.throws(() => parseCreateBody({ name: 'Env', dataType: 'DROPDOWN' }), ApiError);
    assert.throws(
      () => parseCreateBody({ name: 'Env', dataType: 'DROPDOWN', defaultOptions: [] }),
      ApiError,
    );
    assert.throws(
      () => parseCreateBody({ name: 'Env', dataType: 'DROPDOWN', defaultOptions: ['ok', ''] }),
      ApiError,
    );
    const ok = parseCreateBody({
      name: 'Env',
      dataType: 'DROPDOWN',
      defaultOptions: [' Dev ', 'Prod'],
    });
    assert.deepEqual(ok.defaultOptions, ['Dev', 'Prod']);
    assert.equal(ok.regexpPattern, null);
  });

  it('ignores pattern/options for types that do not use them', () => {
    const parsed = parseCreateBody({
      name: 'Age',
      dataType: 'NUMERIC',
      regexpPattern: '\\d+',
      defaultOptions: ['x'],
    });
    assert.equal(parsed.regexpPattern, null);
    assert.equal(parsed.defaultOptions, null);
  });
});

describe('POST /admin/data-points (create)', () => {
  it('creates a data point, returns 201 with the view, and audits every column (R14.2, R17)', async () => {
    const store = new FakeDataPointStore();
    const audit = new RecordingAuditWriter();
    const res = fakeResponse();

    await invoke(
      createDataPointCreateHandler(store, audit, fakeTx),
      adminReq({ body: { name: 'Summary', dataType: 'TEXT', defaultHelpText: 'One line' } }),
      res,
    );

    assert.equal(res.statusCode, 201);
    const body = res.body as ReturnType<typeof serializeDataPoint>;
    assert.equal(body.name, 'Summary');
    assert.equal(body.dataType, 'TEXT');
    assert.equal(body.defaultHelpText, 'One line');
    assert.equal(body.isRetired, false);
    assert.equal(typeof body.createdAt, 'string');

    // One audit call, one row per column, tagged to the created data point.
    assert.equal(audit.calls.length, 1);
    assert.equal(audit.calls[0].ctx.entityType, 'data_point');
    assert.equal(audit.calls[0].ctx.entityId, body.id);
    assert.equal(audit.calls[0].ctx.changedById, 7);
    const fields = audit.calls[0].changes.map((c) => c.field).sort();
    assert.deepEqual(fields, [
      'data_type',
      'default_help_text',
      'default_options',
      'description',
      'is_retired',
      'name',
      'regexp_pattern',
    ]);
  });

  it('persists a DROPDOWN default option list (R3.5, R14.2)', async () => {
    const store = new FakeDataPointStore();
    const audit = new RecordingAuditWriter();
    const res = fakeResponse();

    await invoke(
      createDataPointCreateHandler(store, audit, fakeTx),
      adminReq({ body: { name: 'Environment', dataType: 'DROPDOWN', defaultOptions: ['Dev', 'Prod'] } }),
      res,
    );

    const body = res.body as ReturnType<typeof serializeDataPoint>;
    assert.deepEqual(body.defaultOptions, ['Dev', 'Prod']);
    // The audit row for default_options carries the JSON-encoded list.
    const optChange = audit.calls[0].changes.find((c) => c.field === 'default_options');
    assert.equal(optChange?.newValue, JSON.stringify(['Dev', 'Prod']));
  });

  it('persists a REGEXP pattern (R3.4, R14.2)', async () => {
    const store = new FakeDataPointStore();
    const audit = new RecordingAuditWriter();
    const res = fakeResponse();

    await invoke(
      createDataPointCreateHandler(store, audit, fakeTx),
      adminReq({ body: { name: 'JiraRef', dataType: 'REGEXP', regexpPattern: '^JIRA-\\d+$' } }),
      res,
    );

    const body = res.body as ReturnType<typeof serializeDataPoint>;
    assert.equal(body.regexpPattern, '^JIRA-\\d+$');
    assert.equal(body.defaultOptions, null);
  });

  it('rejects a malformed body with VALIDATION_FAILED and writes no audit', async () => {
    const store = new FakeDataPointStore();
    const audit = new RecordingAuditWriter();
    const res = fakeResponse();

    const err = await invoke(
      createDataPointCreateHandler(store, audit, fakeTx),
      adminReq({ body: { dataType: 'TEXT' } }), // no name
      res,
    );

    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).code, 'VALIDATION_FAILED');
    assert.equal(store.rows.size, 0);
    assert.equal(audit.calls.length, 0);
  });
});

describe('GET /admin/data-points (list)', () => {
  it('returns every data point including retired ones (R14.1)', async () => {
    const store = new FakeDataPointStore();
    await store.create({
      name: 'Beta',
      dataType: 'TEXT',
      description: null,
      defaultHelpText: null,
      regexpPattern: null,
      defaultOptions: null,
    });
    const alpha = await store.create({
      name: 'Alpha',
      dataType: 'TEXT',
      description: null,
      defaultHelpText: null,
      regexpPattern: null,
      defaultOptions: null,
    });
    await store.retire(alpha.id);

    const res = fakeResponse();
    await invoke(createDataPointListHandler(store), adminReq(), res);

    assert.equal(res.statusCode, 200);
    const body = res.body as { dataPoints: Array<ReturnType<typeof serializeDataPoint>> };
    assert.equal(body.dataPoints.length, 2);
    // Sorted by name; retired point still present (R14.4/R20.4).
    assert.equal(body.dataPoints[0].name, 'Alpha');
    assert.equal(body.dataPoints[0].isRetired, true);
    assert.equal(body.dataPoints[1].name, 'Beta');
    assert.equal(body.dataPoints[1].isRetired, false);
  });
});

describe('PATCH /admin/data-points/:id (retire)', () => {
  it('retires a data point and audits the is_retired change (R14.3, R17)', async () => {
    const store = new FakeDataPointStore();
    const audit = new RecordingAuditWriter();
    const dp = await store.create({
      name: 'Legacy',
      dataType: 'TEXT',
      description: null,
      defaultHelpText: null,
      regexpPattern: null,
      defaultOptions: null,
    });
    const res = fakeResponse();

    await invoke(
      createDataPointRetireHandler(store, audit, fakeTx),
      adminReq({ params: { id: String(dp.id) } }),
      res,
    );

    assert.equal(res.statusCode, 200);
    const body = res.body as ReturnType<typeof serializeDataPoint>;
    assert.equal(body.isRetired, true);
    // The row is retained, only flagged (R20.4 — never deleted).
    assert.equal(store.rows.size, 1);

    assert.equal(audit.calls.length, 1);
    assert.deepEqual(audit.calls[0].changes, [
      { field: 'is_retired', oldValue: false, newValue: true },
    ]);
  });

  it('is idempotent: retiring an already-retired point writes no audit (R14.4)', async () => {
    const store = new FakeDataPointStore();
    const audit = new RecordingAuditWriter();
    const dp = await store.create({
      name: 'Legacy',
      dataType: 'TEXT',
      description: null,
      defaultHelpText: null,
      regexpPattern: null,
      defaultOptions: null,
    });
    await store.retire(dp.id);
    const res = fakeResponse();

    await invoke(
      createDataPointRetireHandler(store, audit, fakeTx),
      adminReq({ params: { id: String(dp.id) } }),
      res,
    );

    assert.equal(res.statusCode, 200);
    assert.equal((res.body as ReturnType<typeof serializeDataPoint>).isRetired, true);
    assert.equal(audit.calls.length, 0);
  });

  it('404s a missing data point', async () => {
    const store = new FakeDataPointStore();
    const audit = new RecordingAuditWriter();
    const res = fakeResponse();

    const err = await invoke(
      createDataPointRetireHandler(store, audit, fakeTx),
      adminReq({ params: { id: '999' } }),
      res,
    );

    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).status, 404);
    assert.equal((err as ApiError).code, 'NOT_FOUND');
  });

  it('rejects a malformed id with VALIDATION_FAILED', async () => {
    const store = new FakeDataPointStore();
    const audit = new RecordingAuditWriter();
    const res = fakeResponse();

    const err = await invoke(
      createDataPointRetireHandler(store, audit, fakeTx),
      adminReq({ params: { id: 'abc' } }),
      res,
    );

    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).code, 'VALIDATION_FAILED');
  });
});
