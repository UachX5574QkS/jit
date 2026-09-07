import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  createGetTeamHandler,
  createUpdateTeamHandler,
  createTeamLeaderRouter,
  readUpdateTeamLeaderBody,
  serializeTeamWithMembers,
} from './team-leader.routes.js';
import {
  MemberRemovalConflictError,
  TeamNotFoundError,
  type TeamLeaderStore,
  type TeamWithMembers,
  type UpdateTeamLeaderInput,
} from './team-leader.store.js';
import { ApiError } from '../middleware/errors.js';
import { requireTeamLeadership } from '../middleware/authorize.js';
import { buildCurrentUser, type CurrentUser } from '../identity/index.js';

/**
 * Tests for the Team-Leader team-management endpoints (design: "Administration",
 * R15, R20.3). Handlers are invoked directly with fake req/res/next — no HTTP
 * server, no database — matching the project's injectable unit-test style. The
 * {@link TeamLeaderStore} is an in-memory fake so the handlers' contract
 * (validation, status codes, JSON shape, guard→error mapping) is exercised
 * independently of Postgres. The removal-guard SQL and audit writes are covered
 * against a fake queryable in team-leader.store.test.ts.
 *
 * The final block exercises the ROLE BOUNDARY (R15): the router wires
 * {@link requireTeamLeadership} keyed on `:id`, and that guard admits ONLY the
 * recorded leader of THAT team — a non-leader, and even a leader of a DIFFERENT
 * team, are rejected with FORBIDDEN before any handler runs.
 */

/** A team-with-members shape as the store would return it. */
function teamWithMembers(overrides: Partial<TeamWithMembers['team']> = {}): TeamWithMembers {
  return {
    team: {
      id: 1,
      title: 'Payments',
      description: 'Handles money',
      teamLeaderId: 100,
      isClosed: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    },
    members: [
      { userId: 200, username: '00000200', displayName: 'Ada Lovelace' },
      { userId: 201, username: '00000201', displayName: 'Grace Hopper' },
    ],
  };
}

/**
 * An in-memory {@link TeamLeaderStore}. `getWithMembers` returns the seeded
 * team (or throws not-found); `update` applies detail/membership changes and
 * enforces the removal guard using the supplied `openCounts` map (member id →
 * non-closed request count under the team), so a handler test can drive the
 * CONFLICT_OPEN_REQUESTS path without a database.
 */
function fakeStore(options: {
  seed?: TeamWithMembers;
  openCounts?: Record<number, number>;
} = {}): TeamLeaderStore & { lastUpdate?: { input: UpdateTeamLeaderInput; actingUserId: number } } {
  const state = options.seed ?? teamWithMembers();
  const openCounts = options.openCounts ?? {};
  const store: TeamLeaderStore & {
    lastUpdate?: { input: UpdateTeamLeaderInput; actingUserId: number };
  } = {
    async getWithMembers(teamId: number): Promise<TeamWithMembers> {
      if (teamId !== state.team.id) {
        throw new TeamNotFoundError(teamId);
      }
      return state;
    },
    async update(
      teamId: number,
      input: UpdateTeamLeaderInput,
      actingUserId: number,
    ): Promise<TeamWithMembers> {
      if (teamId !== state.team.id) {
        throw new TeamNotFoundError(teamId);
      }
      for (const userId of input.removeMemberIds ?? []) {
        const open = openCounts[userId] ?? 0;
        if (open > 0) {
          throw new MemberRemovalConflictError(teamId, userId, open);
        }
      }
      store.lastUpdate = { input, actingUserId };
      return {
        team: {
          ...state.team,
          title: input.title ?? state.team.title,
          description:
            input.description !== undefined ? input.description : state.team.description,
          updatedAt: '2026-02-02T00:00:00.000Z',
        },
        members: state.members,
      };
    },
  };
  return store;
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

/** A request as an authenticated team leader (id 100). */
function leaderReq(extra: Partial<Request> = {}): Partial<Request> {
  return {
    currentUser: { id: 100 } as never,
    params: {},
    body: {},
    ...extra,
  };
}

/** Build a real {@link CurrentUser} leading the given teams (for guard tests). */
function currentUserLeading(teamsLed: number[]): CurrentUser {
  return buildCurrentUser({
    id: 100,
    username: '00000100',
    firstName: 'Lead',
    surname: 'Er',
    timezone: null,
    teamsLed,
    teamsMemberOf: [],
    isAdmin: false,
  });
}

// ── Body validation (R15.2, R15.3) ────────────────────────────────────────────

describe('readUpdateTeamLeaderBody', () => {
  it('accepts a title change alone and trims it', () => {
    assert.deepEqual(readUpdateTeamLeaderBody({ title: '  Payments Team  ' }), {
      title: 'Payments Team',
    });
  });

  it('accepts description set to null (clearing it)', () => {
    assert.deepEqual(readUpdateTeamLeaderBody({ description: null }), {
      description: null,
    });
  });

  it('treats a blank description string as null', () => {
    assert.deepEqual(readUpdateTeamLeaderBody({ description: '   ' }), {
      description: null,
    });
  });

  it('accepts add/remove member id lists', () => {
    assert.deepEqual(
      readUpdateTeamLeaderBody({ addMemberIds: [200], removeMemberIds: [201] }),
      { addMemberIds: [200], removeMemberIds: [201] },
    );
  });

  it('rejects an empty patch with VALIDATION_FAILED', () => {
    assert.throws(
      () => readUpdateTeamLeaderBody({}),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });

  it('rejects a blank title', () => {
    for (const title of ['', '   ', 123]) {
      assert.throws(
        () => readUpdateTeamLeaderBody({ title }),
        (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
      );
    }
  });

  it('rejects a non-array or non-positive-int member id list', () => {
    assert.throws(
      () => readUpdateTeamLeaderBody({ addMemberIds: 200 }),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
    for (const bad of [0, -1, 'x', 1.5]) {
      assert.throws(
        () => readUpdateTeamLeaderBody({ removeMemberIds: [bad] }),
        (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
      );
    }
  });

  it('rejects a user id that is both added and removed', () => {
    assert.throws(
      () => readUpdateTeamLeaderBody({ addMemberIds: [200], removeMemberIds: [200] }),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });
});

// ── GET /team-leader/teams/:id — details + membership (R15.2, R15.3) ──────────

describe('GET /team-leader/teams/:id (details + membership, R15.2, R15.3)', () => {
  it('returns 200 with the team and its members', async () => {
    const store = fakeStore({ seed: teamWithMembers({ id: 1, title: 'Access' }) });
    const res = fakeResponse();
    const err = await invoke(
      createGetTeamHandler(store),
      leaderReq({ params: { id: '1' } }),
      res,
    );

    assert.equal(err, undefined);
    assert.equal(res.statusCode, 200);
    const body = res.body as ReturnType<typeof serializeTeamWithMembers>;
    assert.equal(body.team.title, 'Access');
    assert.equal(body.members.length, 2);
    assert.deepEqual(
      body.members.map((m) => m.displayName),
      ['Ada Lovelace', 'Grace Hopper'],
    );
  });

  it('404s an unknown team id', async () => {
    const store = fakeStore({ seed: teamWithMembers({ id: 1 }) });
    const res = fakeResponse();
    const err = await invoke(
      createGetTeamHandler(store),
      leaderReq({ params: { id: '999' } }),
      res,
    );
    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).code, 'NOT_FOUND');
  });

  it('rejects a malformed team id with VALIDATION_FAILED', async () => {
    const store = fakeStore();
    const res = fakeResponse();
    const err = await invoke(
      createGetTeamHandler(store),
      leaderReq({ params: { id: 'abc' } }),
      res,
    );
    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).code, 'VALIDATION_FAILED');
  });
});

// ── PATCH /team-leader/teams/:id — details + membership (R15.2–15.4) ──────────

describe('PATCH /team-leader/teams/:id (update details / membership, R15.2, R15.3)', () => {
  it('updates details and returns 200 with the updated team, recording the actor', async () => {
    const store = fakeStore({ seed: teamWithMembers({ id: 1, title: 'Payments' }) });
    const res = fakeResponse();
    const err = await invoke(
      createUpdateTeamHandler(store),
      leaderReq({ params: { id: '1' }, body: { title: 'Payments Team' } }),
      res,
    );

    assert.equal(err, undefined);
    assert.equal(res.statusCode, 200);
    assert.equal(
      (res.body as ReturnType<typeof serializeTeamWithMembers>).team.title,
      'Payments Team',
    );
    // The audit actor threaded to the store is the authenticated leader.
    assert.equal(store.lastUpdate?.actingUserId, 100);
  });

  it('applies a membership add and returns the updated membership', async () => {
    const store = fakeStore({ seed: teamWithMembers({ id: 1 }) });
    const res = fakeResponse();
    const err = await invoke(
      createUpdateTeamHandler(store),
      leaderReq({ params: { id: '1' }, body: { addMemberIds: [202] } }),
      res,
    );

    assert.equal(err, undefined);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(store.lastUpdate?.input, { addMemberIds: [202] });
  });

  it('surfaces a validation error via next() for an empty patch', async () => {
    const store = fakeStore({ seed: teamWithMembers({ id: 1 }) });
    const res = fakeResponse();
    const err = await invoke(
      createUpdateTeamHandler(store),
      leaderReq({ params: { id: '1' }, body: {} }),
      res,
    );
    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).code, 'VALIDATION_FAILED');
    assert.equal(res.statusCode, undefined, 'no response written on validation failure');
  });

  it('404s an unknown team id', async () => {
    const store = fakeStore({ seed: teamWithMembers({ id: 1 }) });
    const res = fakeResponse();
    const err = await invoke(
      createUpdateTeamHandler(store),
      leaderReq({ params: { id: '999' }, body: { title: 'X' } }),
      res,
    );
    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).code, 'NOT_FOUND');
  });
});

// ── The member-removal guard mapped to the uniform envelope (R15.4 / R20.3) ───

describe('PATCH /team-leader/teams/:id (member-removal guard, R15.4 / R20.3)', () => {
  it('removes a member who has no non-closed requests', async () => {
    const store = fakeStore({
      seed: teamWithMembers({ id: 1 }),
      openCounts: { 200: 0 },
    });
    const res = fakeResponse();
    const err = await invoke(
      createUpdateTeamHandler(store),
      leaderReq({ params: { id: '1' }, body: { removeMemberIds: [200] } }),
      res,
    );

    assert.equal(err, undefined);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(store.lastUpdate?.input, { removeMemberIds: [200] });
  });

  it('refuses to remove a member with non-closed requests → CONFLICT_OPEN_REQUESTS (409)', async () => {
    const store = fakeStore({
      seed: teamWithMembers({ id: 1 }),
      openCounts: { 200: 4 },
    });
    const res = fakeResponse();
    const err = await invoke(
      createUpdateTeamHandler(store),
      leaderReq({ params: { id: '1' }, body: { removeMemberIds: [200] } }),
      res,
    );

    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).code, 'CONFLICT_OPEN_REQUESTS');
    assert.equal((err as ApiError).status, 409);
    assert.deepEqual((err as ApiError).details, {
      teamId: 1,
      userId: 200,
      openRequestCount: 4,
    });
    // Guard blocked the mutation: no successful update recorded.
    assert.equal(store.lastUpdate, undefined);
  });
});

// ── Role boundary: leader-of-THIS-team only (R15) ─────────────────────────────

describe('createTeamLeaderRouter — leadership role boundary (R15)', () => {
  function routeLayers(router: ReturnType<typeof createTeamLeaderRouter>) {
    return (router as unknown as { stack: Array<Record<string, unknown>> }).stack;
  }

  it('wires GET/PATCH /teams/:id each with a guard before the handler', () => {
    const router = createTeamLeaderRouter(fakeStore());
    const found: Record<string, number> = {};
    for (const layer of routeLayers(router)) {
      const route = layer['route'] as
        | { path: string; methods: Record<string, boolean>; stack: unknown[] }
        | undefined;
      if (!route) continue;
      const method = Object.keys(route.methods)[0];
      found[`${method.toUpperCase()} ${route.path}`] = route.stack.length;
    }
    // guard + handler = 2 layers → proves a guard runs before every handler.
    assert.equal(found['GET /teams/:id'], 2);
    assert.equal(found['PATCH /teams/:id'], 2);
  });

  it('requireTeamLeadership(id) admits the recorded leader of THAT team', () => {
    const guard = requireTeamLeadership('id');
    const req = { currentUser: currentUserLeading([1]), params: { id: '1' } } as unknown as Request;
    let error: unknown = 'not-called';
    guard(req, {} as Response, (e?: unknown) => (error = e));
    assert.equal(error, undefined, 'the leader of team 1 is allowed through');
  });

  it('rejects a leader of a DIFFERENT team with FORBIDDEN (403)', () => {
    const guard = requireTeamLeadership('id');
    const req = { currentUser: currentUserLeading([2]), params: { id: '1' } } as unknown as Request;
    let error: unknown;
    guard(req, {} as Response, (e?: unknown) => (error = e));
    assert.ok(error instanceof ApiError);
    assert.equal((error as ApiError).code, 'FORBIDDEN');
    assert.equal((error as ApiError).status, 403);
  });

  it('rejects a non-leader (no teams led) with FORBIDDEN (403)', () => {
    const guard = requireTeamLeadership('id');
    const req = { currentUser: currentUserLeading([]), params: { id: '1' } } as unknown as Request;
    let error: unknown;
    guard(req, {} as Response, (e?: unknown) => (error = e));
    assert.ok(error instanceof ApiError);
    assert.equal((error as ApiError).code, 'FORBIDDEN');
    assert.equal((error as ApiError).status, 403);
  });

  it('rejects an unauthenticated request with FORBIDDEN (401)', () => {
    const guard = requireTeamLeadership('id');
    const req = { params: { id: '1' } } as unknown as Request;
    let error: unknown;
    guard(req, {} as Response, (e?: unknown) => (error = e));
    assert.ok(error instanceof ApiError);
    assert.equal((error as ApiError).code, 'FORBIDDEN');
    assert.equal((error as ApiError).status, 401);
  });
});
