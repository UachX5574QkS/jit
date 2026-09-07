import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  createAuthenticate,
  requireAdmin,
  requireRole,
  requireTeamLeadership,
  requireTeamMembership,
} from './authorize.js';
import { ApiError } from './errors.js';
import { CurrentUserResolver } from '../identity/resolver.js';
import type { AuthSource } from '../identity/auth-source.js';
import type { UserIdentityLoader } from '../identity/identity-loader.js';
import { buildCurrentUser, type UserIdentity } from '../identity/current-user.js';

/**
 * Tests for the role-based authorisation middleware (R1.8). Each guard is
 * exercised at every role boundary — allowed AND denied — for the four roles
 * USER, SUPPORT_MEMBER, TEAM_LEADER, ADMINISTRATOR. The middleware is invoked
 * directly with fake req/res/next (no HTTP server, no database), matching the
 * project's DB-free unit-test style.
 */

/** A minimal identity with no memberships; override fields per test. */
function identity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    id: 1,
    username: '11111111',
    firstName: 'Test',
    surname: 'Person',
    timezone: null,
    teamsLed: [],
    teamsMemberOf: [],
    isAdmin: false,
    ...overrides,
  };
}

/** Four canonical principals, one per role boundary. */
const plainUser = identity({ id: 1 });
const supportMember = identity({ id: 2, teamsMemberOf: [10] });
const teamLeader = identity({ id: 3, teamsLed: [10], teamsMemberOf: [10] });
const administrator = identity({ id: 4, isAdmin: true });

/** An AuthSource that always reports a fixed principal id (or null). */
function fixedAuthSource(principalId: number | null): AuthSource {
  return { resolvePrincipalId: () => principalId };
}

/** A loader backed by an in-memory map, so tests need no database. */
function fakeLoader(byId: Record<number, UserIdentity>): UserIdentityLoader {
  return { load: async (id) => byId[id] ?? null };
}

const allUsers: Record<number, UserIdentity> = {
  1: plainUser,
  2: supportMember,
  3: teamLeader,
  4: administrator,
};

/**
 * Run a middleware and capture the outcome: either it called `next()` with no
 * argument (allowed) or it called `next(err)` with an {@link ApiError} (denied).
 * A fake request pre-loaded with `currentUser` lets the synchronous guards run
 * without the authenticate step.
 */
function runGuard(
  middleware: (req: Request, res: Response, next: (err?: unknown) => void) => void,
  req: Partial<Request>,
): { error?: unknown } {
  let captured: { error?: unknown } = {};
  const next = (err?: unknown) => {
    captured = { error: err };
  };
  middleware(req as Request, {} as Response, next);
  return captured;
}

/** Build a fake request carrying a resolved current user built from `id`. */
function reqAs(userIdentity: UserIdentity, extra: Partial<Request> = {}): Partial<Request> {
  return { currentUser: buildCurrentUser(userIdentity), params: {}, body: {}, ...extra };
}

function assertAllowed(outcome: { error?: unknown }): void {
  assert.equal(outcome.error, undefined, 'expected the guard to allow the request');
}

function assertForbidden(outcome: { error?: unknown }, expectedStatus = 403): void {
  assert.ok(outcome.error instanceof ApiError, 'expected an ApiError');
  const err = outcome.error as ApiError;
  assert.equal(err.code, 'FORBIDDEN');
  assert.equal(err.status, expectedStatus);
}

describe('authenticate (attaches CurrentUser / 401 when unauthenticated)', () => {
  it('resolves and attaches the current user, then calls next()', async () => {
    const resolver = new CurrentUserResolver(fixedAuthSource(1), fakeLoader(allUsers));
    const mw = createAuthenticate(resolver);
    const req = { params: {}, body: {} } as unknown as Request;

    await new Promise<void>((resolve, reject) => {
      mw(
        req,
        {} as Response,
        (err?: unknown) => (err ? reject(err) : resolve()),
      );
    });

    assert.ok(req.currentUser);
    assert.equal(req.currentUser.id, 1);
  });

  it('rejects an unauthenticated request with 401 FORBIDDEN', async () => {
    const resolver = new CurrentUserResolver(fixedAuthSource(null), fakeLoader(allUsers));
    const mw = createAuthenticate(resolver);
    const req = { params: {}, body: {} } as unknown as Request;

    const err = await new Promise<unknown>((resolve) => {
      mw(req, {} as Response, (e?: unknown) => resolve(e));
    });

    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).status, 401);
    assert.equal((err as ApiError).code, 'FORBIDDEN');
    assert.equal(req.currentUser, undefined);
  });

  it('rejects a stale principal (no such user) with 401 FORBIDDEN', async () => {
    const resolver = new CurrentUserResolver(fixedAuthSource(999), fakeLoader(allUsers));
    const mw = createAuthenticate(resolver);
    const req = { params: {}, body: {} } as unknown as Request;

    const err = await new Promise<unknown>((resolve) => {
      mw(req, {} as Response, (e?: unknown) => resolve(e));
    });

    assert.ok(err instanceof ApiError);
    assert.equal((err as ApiError).status, 401);
  });

  it('forwards a resolver failure to next (does not attach a user)', async () => {
    const boom: UserIdentityLoader = {
      load: async () => {
        throw new Error('db down');
      },
    };
    const resolver = new CurrentUserResolver(fixedAuthSource(1), boom);
    const mw = createAuthenticate(resolver);
    const req = { params: {}, body: {} } as unknown as Request;

    const err = await new Promise<unknown>((resolve) => {
      mw(req, {} as Response, (e?: unknown) => resolve(e));
    });

    assert.ok(err instanceof Error);
    assert.equal(req.currentUser, undefined);
  });
});

describe('requireRole (allowed vs denied per role boundary)', () => {
  it('allows USER when USER is required (every principal is a USER)', () => {
    for (const u of [plainUser, supportMember, teamLeader, administrator]) {
      assertAllowed(runGuard(requireRole('USER'), reqAs(u)));
    }
  });

  it('SUPPORT_MEMBER boundary: member allowed, plain user denied', () => {
    assertAllowed(runGuard(requireRole('SUPPORT_MEMBER'), reqAs(supportMember)));
    assertForbidden(runGuard(requireRole('SUPPORT_MEMBER'), reqAs(plainUser)));
  });

  it('TEAM_LEADER boundary: leader allowed, support member denied', () => {
    assertAllowed(runGuard(requireRole('TEAM_LEADER'), reqAs(teamLeader)));
    assertForbidden(runGuard(requireRole('TEAM_LEADER'), reqAs(supportMember)));
  });

  it('ADMINISTRATOR boundary: admin allowed, leader denied', () => {
    assertAllowed(runGuard(requireRole('ADMINISTRATOR'), reqAs(administrator)));
    assertForbidden(runGuard(requireRole('ADMINISTRATOR'), reqAs(teamLeader)));
  });

  it('treats multiple roles as an OR (any one grants access)', () => {
    const guard = requireRole('TEAM_LEADER', 'ADMINISTRATOR');
    assertAllowed(runGuard(guard, reqAs(teamLeader)));
    assertAllowed(runGuard(guard, reqAs(administrator)));
    assertForbidden(runGuard(guard, reqAs(supportMember)));
  });

  it('returns 401 when no user was resolved (guard reached without authenticate)', () => {
    assertForbidden(runGuard(requireRole('USER'), { params: {}, body: {} }), 401);
  });
});

describe('requireAdmin', () => {
  it('allows an administrator and denies every non-admin role', () => {
    assertAllowed(runGuard(requireAdmin, reqAs(administrator)));
    assertForbidden(runGuard(requireAdmin, reqAs(plainUser)));
    assertForbidden(runGuard(requireAdmin, reqAs(supportMember)));
    assertForbidden(runGuard(requireAdmin, reqAs(teamLeader)));
  });
});

describe('requireTeamLeadership (per-team boundary)', () => {
  it('allows the leader of the team named in the route params', () => {
    assertAllowed(
      runGuard(requireTeamLeadership(), reqAs(teamLeader, { params: { teamId: '10' } })),
    );
  });

  it('denies a leader for a team they do not lead', () => {
    assertForbidden(
      runGuard(requireTeamLeadership(), reqAs(teamLeader, { params: { teamId: '99' } })),
    );
  });

  it('denies a support member and an administrator (not a leader of the team)', () => {
    assertForbidden(
      runGuard(requireTeamLeadership(), reqAs(supportMember, { params: { teamId: '10' } })),
    );
    assertForbidden(
      runGuard(requireTeamLeadership(), reqAs(administrator, { params: { teamId: '10' } })),
    );
  });

  it('reads the team id from the request body when not in params', () => {
    assertAllowed(
      runGuard(requireTeamLeadership(), reqAs(teamLeader, { body: { teamId: 10 } })),
    );
  });

  it('denies when no team id is present or it is malformed', () => {
    assertForbidden(runGuard(requireTeamLeadership(), reqAs(teamLeader)));
    assertForbidden(
      runGuard(requireTeamLeadership(), reqAs(teamLeader, { params: { teamId: 'abc' } })),
    );
  });
});

describe('requireTeamMembership (per-team boundary)', () => {
  it('allows a member of the team named in the route params', () => {
    assertAllowed(
      runGuard(requireTeamMembership(), reqAs(supportMember, { params: { teamId: '10' } })),
    );
  });

  it('denies a member for a team they do not belong to', () => {
    assertForbidden(
      runGuard(requireTeamMembership(), reqAs(supportMember, { params: { teamId: '99' } })),
    );
  });

  it('denies a plain user (member of no team)', () => {
    assertForbidden(
      runGuard(requireTeamMembership(), reqAs(plainUser, { params: { teamId: '10' } })),
    );
  });

  it('allows a team leader who is also a member of that team', () => {
    assertAllowed(
      runGuard(requireTeamMembership(), reqAs(teamLeader, { params: { teamId: '10' } })),
    );
  });
});
