import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  createCreateTaskHandler,
  createNewVersionHandler,
  createRetireTaskHandler,
  createTaskLeaderRouter,
  readCreateTaskBody,
  readCreateVersionBody,
  readFieldInput,
  serializeTask,
} from './task-leader.routes.js';
import {
  RetiredDataPointError,
  TaskNotFoundError,
  type CreateTaskInput,
  type CreateVersionInput,
  type TaskLeaderStore,
  type TaskView,
} from './task-leader.store.js';
import { ApiError } from '../middleware/errors.js';

/**
 * Tests for the Team-Leader task endpoints (design: "Administration", R16,
 * R20.4). Handlers are invoked directly with fake req/res/next — no HTTP
 * server, no database — matching the project's injectable unit-test style. The
 * {@link TaskLeaderStore} is an in-memory fake so the handlers' contract (body
 * validation incl. the R16.3 override restriction, leader-only authorisation,
 * status codes, JSON shape, guard→error mapping) is exercised independently of
 * Postgres. Version-pinning and retirement SQL are covered against a fake
 * queryable in task-leader.store.test.ts.
 */

/** A task view with sensible defaults; override per test. */
function taskView(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: 5,
    teamId: 1,
    name: 'Onboard',
    isRetired: false,
    currentVersion: { id: 50, versionNo: 1, supportNotes: null, fields: [] },
    ...overrides,
  };
}

/**
 * An in-memory {@link TaskLeaderStore}. `teamByTask` maps task id → owning team
 * (drives findTeamIdForTask and thus the leadership check); `retiredDataPoints`
 * makes create/createVersion reject those data point ids (R16.2); `known`
 * lists which task ids exist (unknown → TaskNotFoundError on edit/retire).
 */
interface FakeTaskStore extends TaskLeaderStore {
  createdWith?: CreateTaskInput;
  versionedWith?: CreateVersionInput;
  retiredId?: number;
}
function fakeStore(options: {
  teamByTask?: Record<number, number>;
  retiredDataPoints?: number[];
  createResult?: TaskView;
  versionResult?: TaskView;
  retireResult?: TaskView;
} = {}): FakeTaskStore {
  const teamByTask = options.teamByTask ?? {};
  const retired = new Set(options.retiredDataPoints ?? []);
  const guardFields = (fields: readonly { dataPointId: number }[]) => {
    for (const f of fields) {
      if (retired.has(f.dataPointId)) {
        throw new RetiredDataPointError(f.dataPointId, 'retired');
      }
    }
  };
  const store: FakeTaskStore = {
    async findTeamIdForTask(taskId: number): Promise<number | null> {
      return teamByTask[taskId] ?? null;
    },
    async create(input: CreateTaskInput): Promise<TaskView> {
      guardFields(input.fields);
      store.createdWith = input;
      return options.createResult ?? taskView({ teamId: input.teamId, name: input.name });
    },
    async createVersion(taskId: number, input: CreateVersionInput): Promise<TaskView> {
      if (!(taskId in teamByTask)) {
        throw new TaskNotFoundError(taskId);
      }
      guardFields(input.fields);
      store.versionedWith = input;
      return (
        options.versionResult ??
        taskView({ id: taskId, currentVersion: { id: 60, versionNo: 2, supportNotes: input.supportNotes, fields: [] } })
      );
    },
    async retire(taskId: number): Promise<TaskView> {
      if (!(taskId in teamByTask)) {
        throw new TaskNotFoundError(taskId);
      }
      store.retiredId = taskId;
      return options.retireResult ?? taskView({ id: taskId, isRetired: true });
    },
  };
  return store;
}

interface FakeRes {
  statusCode?: number;
  body?: unknown;
  res: Response;
  onDone?: () => void;
}
function fakeResponse(): FakeRes {
  const state: FakeRes = { res: undefined as unknown as Response };
  const done = () => state.onDone?.();
  state.res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      done();
      return this;
    },
    end() {
      done();
      return this;
    },
  } as unknown as Response;
  return state;
}

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

/** A request as a leader (id 500) who leads the given teams. */
function leaderReq(teamsLed: number[], extra: Partial<Request> = {}): Partial<Request> {
  return {
    currentUser: { id: 500, teamsLed } as never,
    params: {},
    body: {},
    ...extra,
  };
}

// ── Body validation & override restriction (R16.2, R16.3) ─────────────────────

describe('readFieldInput — override restriction (R16.3)', () => {
  it('accepts order, mandatory, description/help/options overrides', () => {
    const f = readFieldInput(
      {
        dataPointId: 10,
        fieldOrder: 2,
        isMandatory: true,
        descriptionOverride: '  custom desc  ',
        helpTextOverride: 'custom help',
        optionsOverride: ['A', ' B '],
      },
      0,
    );
    assert.equal(f.dataPointId, 10);
    assert.equal(f.fieldOrder, 2);
    assert.equal(f.isMandatory, true);
    assert.equal(f.descriptionOverride, 'custom desc');
    assert.deepEqual(f.optionsOverride, ['A', 'B']);
  });

  it('rejects an attempt to override name (R16.3)', () => {
    assert.throws(
      () => readFieldInput({ dataPointId: 10, fieldOrder: 0, name: 'Renamed' }, 0),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });

  it('rejects an attempt to override dataType (R16.3)', () => {
    for (const key of ['dataType', 'data_type']) {
      assert.throws(
        () => readFieldInput({ dataPointId: 10, fieldOrder: 0, [key]: 'TEXT' }, 0),
        (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
      );
    }
  });

  it('rejects a missing/invalid dataPointId and a bad options override', () => {
    assert.throws(
      () => readFieldInput({ fieldOrder: 0 }, 0),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
    assert.throws(
      () => readFieldInput({ dataPointId: 10, fieldOrder: 0, optionsOverride: [] }, 0),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
    assert.throws(
      () => readFieldInput({ dataPointId: 10, fieldOrder: 0, optionsOverride: ['ok', ''] }, 0),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });
});

describe('readCreateTaskBody', () => {
  it('accepts a well-formed body and trims name/supportNotes', () => {
    const input = readCreateTaskBody({
      teamId: 1,
      name: '  Onboard  ',
      supportNotes: '  notes  ',
      fields: [{ dataPointId: 10, fieldOrder: 0, isMandatory: true }],
    });
    assert.equal(input.teamId, 1);
    assert.equal(input.name, 'Onboard');
    assert.equal(input.supportNotes, 'notes');
    assert.equal(input.fields.length, 1);
  });

  it('defaults an absent fields array to empty and empty supportNotes to null', () => {
    const input = readCreateTaskBody({ teamId: 1, name: 'X' });
    assert.deepEqual(input.fields, []);
    assert.equal(input.supportNotes, null);
  });

  it('rejects a missing teamId or blank name', () => {
    assert.throws(
      () => readCreateTaskBody({ name: 'X' }),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
    assert.throws(
      () => readCreateTaskBody({ teamId: 1, name: '   ' }),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });
});

describe('readCreateVersionBody', () => {
  it('allows an edit with no name (keeps existing) and honours fields', () => {
    const input = readCreateVersionBody({ fields: [{ dataPointId: 10, fieldOrder: 0 }] });
    assert.equal(input.name, undefined);
    assert.equal(input.fields.length, 1);
  });

  it('rejects a blank name when supplied', () => {
    assert.throws(
      () => readCreateVersionBody({ name: '   ' }),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });
});

// ── POST /team-leader/tasks — create (R16.1, R16.2) ───────────────────────────

describe('POST /team-leader/tasks (create)', () => {
  it('creates a task and returns 201 with the serialized task', async () => {
    const store = fakeStore();
    const res = fakeResponse();
    const err = await invoke(
      createCreateTaskHandler(store),
      leaderReq([1], { body: { teamId: 1, name: 'Onboard', fields: [{ dataPointId: 10, fieldOrder: 0 }] } }),
      res,
    );
    assert.equal(err, undefined);
    assert.equal(res.statusCode, 201);
    assert.equal((res.body as ReturnType<typeof serializeTask>).name, 'Onboard');
  });

  it('maps a retired data point to VALIDATION_FAILED (R16.2)', async () => {
    const store = fakeStore({ retiredDataPoints: [10] });
    const res = fakeResponse();
    const err = await invoke(
      createCreateTaskHandler(store),
      leaderReq([1], { body: { teamId: 1, name: 'Onboard', fields: [{ dataPointId: 10, fieldOrder: 0 }] } }),
      res,
    );
    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).code, 'VALIDATION_FAILED');
    assert.equal(res.statusCode, undefined);
  });
});

// ── PATCH /team-leader/tasks/:id — new version, leader-only (R16.1, R16.4) ────

describe('PATCH /team-leader/tasks/:id (new version)', () => {
  it('creates a new version for a task the caller leads and returns 200', async () => {
    const store = fakeStore({ teamByTask: { 5: 1 } });
    const res = fakeResponse();
    const err = await invoke(
      createNewVersionHandler(store),
      leaderReq([1], { params: { id: '5' }, body: { supportNotes: 'v2', fields: [{ dataPointId: 10, fieldOrder: 0 }] } }),
      res,
    );
    assert.equal(err, undefined);
    assert.equal(res.statusCode, 200);
    assert.equal((res.body as ReturnType<typeof serializeTask>).currentVersion.versionNo, 2);
  });

  it('rejects a leader of a DIFFERENT team with FORBIDDEN (R16.1)', async () => {
    const store = fakeStore({ teamByTask: { 5: 1 } });
    const res = fakeResponse();
    const err = await invoke(
      createNewVersionHandler(store),
      leaderReq([2], { params: { id: '5' }, body: { fields: [] } }), // leads team 2, task belongs to team 1
      res,
    );
    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).code, 'FORBIDDEN');
    assert.equal((err as ApiError).status, 403);
    // The store's mutation was never reached.
    assert.equal(store.versionedWith, undefined);
  });

  it('404s an unknown task id (before any leadership-specific work)', async () => {
    const store = fakeStore({ teamByTask: {} });
    const res = fakeResponse();
    const err = await invoke(
      createNewVersionHandler(store),
      leaderReq([1], { params: { id: '999' }, body: { fields: [] } }),
      res,
    );
    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).code, 'NOT_FOUND');
  });

  it('rejects a malformed task id with VALIDATION_FAILED', async () => {
    const store = fakeStore({ teamByTask: { 5: 1 } });
    const res = fakeResponse();
    const err = await invoke(
      createNewVersionHandler(store),
      leaderReq([1], { params: { id: 'abc' }, body: { fields: [] } }),
      res,
    );
    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).code, 'VALIDATION_FAILED');
  });
});

// ── POST /team-leader/tasks/:id/retire — retire, leader-only (R16.6, R20.4) ───

describe('POST /team-leader/tasks/:id/retire (retire)', () => {
  it('retires a task the caller leads and returns the retired task', async () => {
    const store = fakeStore({ teamByTask: { 5: 1 } });
    const res = fakeResponse();
    const err = await invoke(
      createRetireTaskHandler(store),
      leaderReq([1], { params: { id: '5' } }),
      res,
    );
    assert.equal(err, undefined);
    assert.equal(res.statusCode, 200);
    assert.equal((res.body as ReturnType<typeof serializeTask>).isRetired, true);
    assert.equal(store.retiredId, 5);
  });

  it('rejects a caller who does not lead the task team with FORBIDDEN (R16.1)', async () => {
    const store = fakeStore({ teamByTask: { 5: 1 } });
    const res = fakeResponse();
    const err = await invoke(
      createRetireTaskHandler(store),
      leaderReq([9], { params: { id: '5' } }),
      res,
    );
    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).code, 'FORBIDDEN');
    // Retirement never happened.
    assert.equal(store.retiredId, undefined);
  });
});

// ── Router wiring (R16.1) ─────────────────────────────────────────────────────

describe('createTaskLeaderRouter (leader-only wiring, R16.1)', () => {
  function routeLayers(router: ReturnType<typeof createTaskLeaderRouter>) {
    return (router as unknown as { stack: Array<Record<string, unknown>> }).stack;
  }

  it('mounts POST /tasks (guarded), PATCH /tasks/:id and POST /tasks/:id/retire', () => {
    const router = createTaskLeaderRouter(fakeStore());
    const found: Record<string, number> = {};
    for (const layer of routeLayers(router)) {
      const route = layer['route'] as
        | { path: string; methods: Record<string, boolean>; stack: unknown[] }
        | undefined;
      if (!route) continue;
      const method = Object.keys(route.methods)[0];
      found[`${method.toUpperCase()} ${route.path}`] = route.stack.length;
    }
    // POST /tasks carries the requireTeamLeadership guard + handler (2 layers).
    assert.equal(found['POST /tasks'], 2);
    // Edit/retire assert leadership inside the handler (1 layer each).
    assert.equal(found['PATCH /tasks/:id'], 1);
    assert.equal(found['POST /tasks/:id/retire'], 1);
  });
});
