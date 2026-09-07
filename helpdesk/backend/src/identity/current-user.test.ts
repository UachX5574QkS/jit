import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCurrentUser,
  deriveRoles,
  hasRole,
  isMemberOfTeam,
  leadsTeam,
  type UserIdentity,
} from './current-user.js';

/** A minimal identity with no memberships; override fields per test. */
function identity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    id: 1,
    username: '11111111',
    firstName: 'Jason',
    surname: 'Hughes',
    timezone: null,
    teamsLed: [],
    teamsMemberOf: [],
    isAdmin: false,
    ...overrides,
  };
}

describe('deriveRoles (additive role superset, R1.8)', () => {
  it('always includes USER for any resolved principal', () => {
    assert.ok(deriveRoles(identity()).has('USER'));
  });

  it('adds SUPPORT_MEMBER when the person is a member of any team', () => {
    const roles = deriveRoles(identity({ teamsMemberOf: [5] }));
    assert.ok(roles.has('SUPPORT_MEMBER'));
  });

  it('does not add SUPPORT_MEMBER when the person is in no team', () => {
    assert.ok(!deriveRoles(identity({ teamsMemberOf: [] })).has('SUPPORT_MEMBER'));
  });

  it('adds TEAM_LEADER when the person leads any team', () => {
    assert.ok(deriveRoles(identity({ teamsLed: [3] })).has('TEAM_LEADER'));
  });

  it('adds ADMINISTRATOR when the person is in the admin group', () => {
    assert.ok(deriveRoles(identity({ isAdmin: true })).has('ADMINISTRATOR'));
  });

  it('is the union of all memberships (a person can hold every role)', () => {
    const roles = deriveRoles(
      identity({ teamsLed: [3], teamsMemberOf: [5], isAdmin: true }),
    );
    assert.deepEqual(
      [...roles].sort(),
      ['ADMINISTRATOR', 'SUPPORT_MEMBER', 'TEAM_LEADER', 'USER'],
    );
  });
});

describe('buildCurrentUser (R1.3, R1.7)', () => {
  it('composes the display name as "firstname surname"', () => {
    const user = buildCurrentUser(identity({ firstName: 'Jason', surname: 'Hughes' }));
    assert.equal(user.displayName, 'Jason Hughes');
  });

  it('carries id, username, and timezone through unchanged', () => {
    const user = buildCurrentUser(
      identity({ id: 42, username: '00000042', timezone: 'Europe/London' }),
    );
    assert.equal(user.id, 42);
    assert.equal(user.username, '00000042');
    assert.equal(user.timezone, 'Europe/London');
  });

  it('preserves a null timezone (frontend falls back to the browser, R18.2)', () => {
    assert.equal(buildCurrentUser(identity({ timezone: null })).timezone, null);
  });

  it('exposes teams led and teams member of', () => {
    const user = buildCurrentUser(
      identity({ teamsLed: [3, 7], teamsMemberOf: [5] }),
    );
    assert.deepEqual([...user.teamsLed], [3, 7]);
    assert.deepEqual([...user.teamsMemberOf], [5]);
  });

  it('keeps isAdmin consistent with the ADMINISTRATOR role', () => {
    const admin = buildCurrentUser(identity({ isAdmin: true }));
    assert.equal(admin.isAdmin, true);
    assert.ok(admin.roles.has('ADMINISTRATOR'));

    const nonAdmin = buildCurrentUser(identity({ isAdmin: false }));
    assert.equal(nonAdmin.isAdmin, false);
    assert.ok(!nonAdmin.roles.has('ADMINISTRATOR'));
  });

  it('freezes the team arrays so callers cannot mutate the resolved identity', () => {
    const user = buildCurrentUser(identity({ teamsLed: [3], teamsMemberOf: [5] }));
    assert.throws(() => (user.teamsLed as number[]).push(9));
    assert.throws(() => (user.teamsMemberOf as number[]).push(9));
  });

  it('does not alias the caller-supplied arrays (defensive copy)', () => {
    const led = [3];
    const user = buildCurrentUser(identity({ teamsLed: led }));
    led.push(99);
    assert.deepEqual([...user.teamsLed], [3]);
  });

  it('does not expose any password material', () => {
    const user = buildCurrentUser(identity());
    assert.ok(!('password_hash' in user));
    assert.ok(!('password' in user));
  });
});

describe('role/team helpers', () => {
  it('hasRole reflects the resolved superset', () => {
    const user = buildCurrentUser(identity({ isAdmin: true }));
    assert.equal(hasRole(user, 'ADMINISTRATOR'), true);
    assert.equal(hasRole(user, 'TEAM_LEADER'), false);
  });

  it('leadsTeam is true only for led teams', () => {
    const user = buildCurrentUser(identity({ teamsLed: [3, 7] }));
    assert.equal(leadsTeam(user, 3), true);
    assert.equal(leadsTeam(user, 5), false);
  });

  it('isMemberOfTeam is true only for member teams', () => {
    const user = buildCurrentUser(identity({ teamsMemberOf: [5] }));
    assert.equal(isMemberOfTeam(user, 5), true);
    assert.equal(isMemberOfTeam(user, 3), false);
  });
});
