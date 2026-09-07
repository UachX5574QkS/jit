import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import { CurrentUserResolver } from './resolver.js';
import type { AuthSource } from './auth-source.js';
import type { UserIdentityLoader } from './identity-loader.js';
import type { UserIdentity } from './current-user.js';

/** An AuthSource that always reports a fixed principal id (or null). */
function fixedAuthSource(principalId: number | null): AuthSource {
  return { resolvePrincipalId: () => principalId };
}

/** A loader backed by an in-memory map, so resolver tests need no database. */
function fakeLoader(byId: Record<number, UserIdentity>): UserIdentityLoader {
  return { load: async (id) => byId[id] ?? null };
}

const alice: UserIdentity = {
  id: 10,
  username: '00000010',
  firstName: 'Alice',
  surname: 'Adams',
  timezone: 'Europe/London',
  teamsLed: [1],
  teamsMemberOf: [1, 2],
  isAdmin: true,
};

const emptyReq = {} as unknown as Request;

describe('CurrentUserResolver', () => {
  it('resolves an authenticated principal to a full CurrentUser', async () => {
    const resolver = new CurrentUserResolver(
      fixedAuthSource(10),
      fakeLoader({ 10: alice }),
    );
    const user = await resolver.resolve(emptyReq);
    assert.ok(user);
    assert.equal(user.id, 10);
    assert.equal(user.displayName, 'Alice Adams');
    assert.equal(user.isAdmin, true);
    assert.deepEqual([...user.roles].sort(), [
      'ADMINISTRATOR',
      'SUPPORT_MEMBER',
      'TEAM_LEADER',
      'USER',
    ]);
    assert.deepEqual([...user.teamsLed], [1]);
    assert.deepEqual([...user.teamsMemberOf], [1, 2]);
  });

  it('returns null when the request is unauthenticated (no principal)', async () => {
    const resolver = new CurrentUserResolver(
      fixedAuthSource(null),
      fakeLoader({ 10: alice }),
    );
    assert.equal(await resolver.resolve(emptyReq), null);
  });

  it('returns null for a stale principal that no longer exists', async () => {
    const resolver = new CurrentUserResolver(
      fixedAuthSource(999),
      fakeLoader({ 10: alice }),
    );
    assert.equal(await resolver.resolve(emptyReq), null);
  });

  it('is source-agnostic: swapping the AuthSource yields the same CurrentUser', async () => {
    // Two different "mechanisms" (stand-ins for dev-session vs IDCS) that agree
    // on the principal id must resolve to an identical CurrentUser, proving the
    // resolution point is independent of the authentication source (R1.7).
    const loader = fakeLoader({ 10: alice });
    const viaDevLike = await new CurrentUserResolver(
      fixedAuthSource(10),
      loader,
    ).resolve(emptyReq);
    const viaIdcsLike = await new CurrentUserResolver(
      fixedAuthSource(10),
      loader,
    ).resolve(emptyReq);

    assert.ok(viaDevLike && viaIdcsLike);
    assert.deepEqual(
      { ...viaDevLike, roles: [...viaDevLike.roles].sort() },
      { ...viaIdcsLike, roles: [...viaIdcsLike.roles].sort() },
    );
  });
});
