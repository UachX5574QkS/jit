import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { QueryResultRow } from 'pg';
import {
  DbUserDirectoryLoader,
  formatDirectoryLabel,
  highestPrivilegeRole,
  type DirectoryUser,
} from './user-directory.js';
import type { Role } from './current-user.js';
import type { Queryable } from '../db/query.js';

/**
 * DB-free unit tests for the login-drop-down directory helpers (design: "Auth &
 * identity", `GET /api/auth/users` dev-only, R1.2; "Passwords", R1.5).
 *
 * The role-selection and label-formatting functions are pure and tested
 * directly; {@link DbUserDirectoryLoader} is tested against a fake `Queryable`
 * so the parameterised lookup and role derivation are covered without a live
 * database — matching the project's injectable test style.
 */

function roles(...list: Role[]): DirectoryUser {
  return {
    username: '11111111',
    firstName: 'Jason',
    surname: 'Hughes',
    roles: new Set<Role>(list),
  };
}

describe('highestPrivilegeRole', () => {
  it('picks ADMINISTRATOR over every other role', () => {
    assert.equal(
      highestPrivilegeRole(new Set(['USER', 'SUPPORT_MEMBER', 'TEAM_LEADER', 'ADMINISTRATOR'])),
      'ADMINISTRATOR',
    );
  });

  it('picks TEAM_LEADER over SUPPORT_MEMBER and USER', () => {
    assert.equal(
      highestPrivilegeRole(new Set(['USER', 'SUPPORT_MEMBER', 'TEAM_LEADER'])),
      'TEAM_LEADER',
    );
  });

  it('picks SUPPORT_MEMBER over USER', () => {
    assert.equal(highestPrivilegeRole(new Set(['USER', 'SUPPORT_MEMBER'])), 'SUPPORT_MEMBER');
  });

  it('falls back to USER for a plain user (or an empty set)', () => {
    assert.equal(highestPrivilegeRole(new Set(['USER'])), 'USER');
    assert.equal(highestPrivilegeRole(new Set()), 'USER');
  });
});

describe('formatDirectoryLabel', () => {
  it('formats the R1.2 example exactly', () => {
    assert.equal(
      formatDirectoryLabel(roles('USER', 'ADMINISTRATOR')),
      '11111111 Jason (Administrator) Hughes',
    );
  });

  it('uses the highest-privilege role label when several are held', () => {
    assert.equal(
      formatDirectoryLabel(roles('USER', 'SUPPORT_MEMBER', 'TEAM_LEADER')),
      '11111111 Jason (Team Leader) Hughes',
    );
  });

  it('labels a plain user as User', () => {
    assert.equal(formatDirectoryLabel(roles('USER')), '11111111 Jason (User) Hughes');
  });
});

/** A fake queryable returning fixed rows and recording the last call. */
function fakeQueryable(rows: QueryResultRow[]): {
  db: Queryable;
  calls: Array<{ text: string; params: unknown[] }>;
} {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const db = {
    query: async (text: string, params: unknown[]) => {
      calls.push({ text, params });
      return { rows } as { rows: QueryResultRow[] };
    },
  } as unknown as Queryable;
  return { db, calls };
}

describe('DbUserDirectoryLoader.loadAll', () => {
  it('derives the additive role superset from the membership facts', async () => {
    const { db, calls } = fakeQueryable([
      {
        username: '11111111',
        first_name: 'Jason',
        surname: 'Hughes',
        is_admin: true,
        leads_team: false,
        is_member: false,
      },
      {
        username: '22222222',
        first_name: 'Amy',
        surname: 'Smith',
        is_admin: false,
        leads_team: true,
        is_member: true,
      },
      {
        username: '33333333',
        first_name: 'Ravi',
        surname: 'Patel',
        is_admin: false,
        leads_team: false,
        is_member: false,
      },
    ]);
    const loader = new DbUserDirectoryLoader(db);

    const users = await loader.loadAll();

    assert.equal(users.length, 3);
    assert.deepEqual([...users[0].roles].sort(), ['ADMINISTRATOR', 'USER']);
    assert.deepEqual([...users[1].roles].sort(), ['SUPPORT_MEMBER', 'TEAM_LEADER', 'USER']);
    assert.deepEqual([...users[2].roles].sort(), ['USER']);

    // No value is interpolated; the query selects display fields, never the hash.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.length, 0);
    assert.doesNotMatch(calls[0].text, /password_hash/);
  });

  it('returns an empty list when there are no users', async () => {
    const { db } = fakeQueryable([]);
    const loader = new DbUserDirectoryLoader(db);
    assert.deepEqual(await loader.loadAll(), []);
  });
});
