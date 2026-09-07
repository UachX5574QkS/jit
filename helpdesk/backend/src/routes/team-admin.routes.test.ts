import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  createCreateTeamHandler,
  createListTeamsHandler,
  createTeamAdminRouter,
  createUpdateTeamHandler,
  readCreateTeamBody,
  readUpdateTeamBody,
  serializeTeam,
} from './team-admin.routes.js';
import {
  OpenRequestsConflictError,
  TeamNotFoundError,
  type CreateTeamInput,
  type TeamAdminStore,
  type TeamRow,
  type UpdateTeamInput,
} from './team-admin.store.js';
import { ApiError } from '../middleware/errors.js';

/**
 * Tests for the Tool-Administrator team endpoints (design: "Administration",
 * R13, R20.2). Handlers are invoked directly with fake req/res/next — no HTTP
 * server, no database — matching the project's injectable unit-test style. The
 * {@link TeamAdminStore} is an in-memory fake so the handlers' contract
 * (validation, status codes, JSON shape, guard→error mapping) is exercised
 * independently of Postgres. The close-guard SQL itself is covered against a
 * fake queryable in team-admin.store.test.ts.
 */

/** Build a team row with sensible defaults; override per test. */
function teamRow(overrides: Partial<TeamRow> = {}): TeamRow {
  return {
    id: 1,
    title: 'Payments',
    description: null,
    teamLeaderId: 100,
    isClosed: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * An in-memory {@link TeamAdminStore}. `create`/`list` operate on a backing map;
 * `update` applies leader/close changes and enforces the open-request close
 * guard using the supplied `openCounts` map (team id → non-closed request
 * count), so a handler test can drive the CONFLICT_OPEN_REQUESTS path.
 */
function fakeStore(options: {
  seed?: TeamRow[];
  openCounts?: Record<number, number>;
} = {}): TeamAdminStore & { rows: Map<number, TeamRow>; createdBy: number[] } {
  const rows = new Map<number, TeamRow>();
  for (const r of options.seed ?? []) {
    rows.set(r.id, r);
  }
  const openCounts = options.openCounts ?? {};
  let nextId = Math.max(0, ...[...rows.keys()]) + 1;
  const createdBy: number[] = [];

  return {
    rows,
    createdBy,
    async create(input: CreateTeamInput, actingUserId: number): Promise<TeamRow> {
      createdBy.push(actingUserId);
      const row = teamRow({
        id: nextId++,
        title: input.title,
        description: input.description,
        teamLeaderId: input.teamLeaderId,
        isClosed: false,
      });
      rows.set(row.id, row);
      return row;
    },
    async list(): Promise<TeamRow[]> {
      return [...rows.values()].sort((a, b) => a.title.localeCompare(b.title));
    },
    async update(
      teamId: number,
      input: UpdateTeamInput,
      _actingUserId: number,
    ): Promise<TeamRow> {
      const current = rows.get(teamId);
      if (!current) {
        throw new TeamNotFoundError(teamId);
      }
      if (input.isClosed === true && !current.isClosed) {
        const open = openCounts[teamId] ?? 0;
        if (open > 0) {
          throw new OpenRequestsConflictError(teamId, open);
        }
      }
      const next: TeamRow = {
        ...current,
        teamLeaderId: input.teamLeaderId ?? current.teamLeaderId,
        isClosed: input.isClosed ?? current.isClosed,
        updatedAt: '2026-02-02T00:00:00.000Z',
      };
      rows.set(teamId, next);
      return next;
    },
  };
}

/** A fake response recording status + JSON body, resolving on terminal json/end. */
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

/** Invoke a handler, settling on next(err) or a terminal response. */
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

/** A request as an authenticated administrator (id 500). */
function adminReq(extra: Partial<Request> = {}): Partial<Request> {
  return {
    currentUser: { id: 500 } as never,
    params: {},
    body: {},
    ...extra,
  };
}

// ── Body validation (R13.2, R13.3) ───────────────────────────────────────────

describe('readCreateTeamBody', () => {
  it('accepts a well-formed body and trims the title', () => {
    const input = readCreateTeamBody({
      title: '  Payments  ',
      description: '  Handles money  ',
      teamLeaderId: 100,
    });
    assert.deepEqual(input, {
      title: 'Payments',
      description: 'Handles money',
      teamLeaderId: 100,
    });
  });

  it('coerces a numeric-string teamLeaderId and empty description to null', () => {
    const input = readCreateTeamBody({ title: 'Ops', teamLeaderId: '42', description: '   ' });
    assert.equal(input.teamLeaderId, 42);
    assert.equal(input.description, null);
  });

  it('rejects a blank title with VALIDATION_FAILED', () => {
    for (const title of [undefined, '', '   ', 123]) {
      assert.throws(
        () => readCreateTeamBody({ title, teamLeaderId: 1 }),
        (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
      );
    }
  });

  it('rejects a missing or invalid teamLeaderId', () => {
    for (const teamLeaderId of [undefined, 0, -3, 'abc', 1.5]) {
      assert.throws(
        () => readCreateTeamBody({ title: 'Ops', teamLeaderId }),
        (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
      );
    }
  });
});

describe('readUpdateTeamBody', () => {
  it('accepts a leader change alone', () => {
    assert.deepEqual(readUpdateTeamBody({ teamLeaderId: 7 }), { teamLeaderId: 7 });
  });

  it('accepts a close flag alone', () => {
    assert.deepEqual(readUpdateTeamBody({ isClosed: true }), { isClosed: true });
  });

  it('accepts both together', () => {
    assert.deepEqual(readUpdateTeamBody({ teamLeaderId: 7, isClosed: false }), {
      teamLeaderId: 7,
      isClosed: false,
    });
  });

  it('rejects an empty patch', () => {
    assert.throws(
      () => readUpdateTeamBody({}),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });

  it('rejects a non-boolean isClosed and a bad teamLeaderId', () => {
    assert.throws(
      () => readUpdateTeamBody({ isClosed: 'yes' }),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
    assert.throws(
      () => readUpdateTeamBody({ teamLeaderId: -1 }),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });
});

// ── POST /admin/teams — create + assign leader (R13.2) ────────────────────────

describe('POST /admin/teams (create + assign leader, R13.2)', () => {
  it('creates a team, returns 201 with the serialized team, and records the actor', async () => {
    const store = fakeStore();
    const res = fakeResponse();
    const err = await invoke(
      createCreateTeamHandler(store),
      adminReq({ body: { title: 'Payments', teamLeaderId: 100 } }),
      res,
    );

    assert.equal(err, undefined);
    assert.equal(res.statusCode, 201);
    const body = res.body as ReturnType<typeof serializeTeam>;
    assert.equal(body.title, 'Payments');
    assert.equal(body.teamLeaderId, 100);
    assert.equal(body.isClosed, false);
    assert.deepEqual(store.createdBy, [500], 'audit actor is the authenticated admin');
  });

  it('surfaces a validation error via next() for a bad body', async () => {
    const store = fakeStore();
    const res = fakeResponse();
    const err = await invoke(
      createCreateTeamHandler(store),
      adminReq({ body: { title: '' } }),
      res,
    );
    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).code, 'VALIDATION_FAILED');
    assert.equal(res.statusCode, undefined, 'no response written on validation failure');
  });
});

// ── GET /admin/teams — list (R13.3) ───────────────────────────────────────────

describe('GET /admin/teams (list, R13.3)', () => {
  it('lists all teams including closed ones', async () => {
    const store = fakeStore({
      seed: [
        teamRow({ id: 1, title: 'Payments', isClosed: false }),
        teamRow({ id: 2, title: 'Access', isClosed: true }),
      ],
    });
    const res = fakeResponse();
    await invoke(createListTeamsHandler(store), adminReq(), res);

    assert.equal(res.statusCode, 200);
    const body = res.body as { teams: ReturnType<typeof serializeTeam>[] };
    assert.equal(body.teams.length, 2);
    // Closed teams remain in the admin list (retained; R20.1 / R13.3).
    assert.ok(body.teams.some((t) => t.isClosed === true));
  });
});

// ── PATCH /admin/teams/:id — change leader / close (R13.3, R20.2) ─────────────

describe('PATCH /admin/teams/:id (change leader, R13.3)', () => {
  it('changes the team leader/owner and returns the updated team', async () => {
    const store = fakeStore({ seed: [teamRow({ id: 1, teamLeaderId: 100 })] });
    const res = fakeResponse();
    const err = await invoke(
      createUpdateTeamHandler(store),
      adminReq({ params: { id: '1' }, body: { teamLeaderId: 200 } }),
      res,
    );

    assert.equal(err, undefined);
    assert.equal(res.statusCode, 200);
    assert.equal((res.body as ReturnType<typeof serializeTeam>).teamLeaderId, 200);
  });

  it('404s an unknown team id', async () => {
    const store = fakeStore();
    const res = fakeResponse();
    const err = await invoke(
      createUpdateTeamHandler(store),
      adminReq({ params: { id: '999' }, body: { teamLeaderId: 200 } }),
      res,
    );
    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).code, 'NOT_FOUND');
  });

  it('rejects a malformed team id with VALIDATION_FAILED', async () => {
    const store = fakeStore();
    const res = fakeResponse();
    const err = await invoke(
      createUpdateTeamHandler(store),
      adminReq({ params: { id: 'abc' }, body: { teamLeaderId: 200 } }),
      res,
    );
    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).code, 'VALIDATION_FAILED');
  });
});

describe('PATCH /admin/teams/:id (close, guarded by open requests, R20.2)', () => {
  it('closes a team that has no non-closed requests', async () => {
    const store = fakeStore({
      seed: [teamRow({ id: 1, isClosed: false })],
      openCounts: { 1: 0 },
    });
    const res = fakeResponse();
    const err = await invoke(
      createUpdateTeamHandler(store),
      adminReq({ params: { id: '1' }, body: { isClosed: true } }),
      res,
    );

    assert.equal(err, undefined);
    assert.equal(res.statusCode, 200);
    assert.equal((res.body as ReturnType<typeof serializeTeam>).isClosed, true);
    // Existing team row is retained (R20.1), just flipped to closed.
    assert.ok(store.rows.get(1));
  });

  it('refuses to close a team with non-closed requests → CONFLICT_OPEN_REQUESTS', async () => {
    const store = fakeStore({
      seed: [teamRow({ id: 1, isClosed: false })],
      openCounts: { 1: 3 },
    });
    const res = fakeResponse();
    const err = await invoke(
      createUpdateTeamHandler(store),
      adminReq({ params: { id: '1' }, body: { isClosed: true } }),
      res,
    );

    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).code, 'CONFLICT_OPEN_REQUESTS');
    assert.equal((err as ApiError).status, 409);
    assert.deepEqual((err as ApiError).details, { teamId: 1, openRequestCount: 3 });
    // The team was NOT closed (guard blocked the mutation).
    assert.equal(store.rows.get(1)?.isClosed, false);
  });
});

// ── Router authorisation wiring (R13.1) ───────────────────────────────────────

describe('createTeamAdminRouter (admin-only wiring, R13.1)', () => {
  function routeLayers(router: ReturnType<typeof createTeamAdminRouter>) {
    return (router as unknown as { stack: Array<Record<string, unknown>> }).stack;
  }

  it('mounts POST/GET /teams and PATCH /teams/:id, each guarded by requireAdmin', () => {
    const router = createTeamAdminRouter(fakeStore());
    const found: Record<string, number> = {};
    for (const layer of routeLayers(router)) {
      const route = layer['route'] as
        | { path: string; methods: Record<string, boolean>; stack: unknown[] }
        | undefined;
      if (!route) continue;
      const method = Object.keys(route.methods)[0];
      const key = `${method.toUpperCase()} ${route.path}`;
      // Each route has the guard + the handler (2 layers) — proves a guard runs
      // before the handler on every admin route.
      found[key] = route.stack.length;
    }
    assert.equal(found['POST /teams'], 2);
    assert.equal(found['GET /teams'], 2);
    assert.equal(found['PATCH /teams/:id'], 2);
  });
});
