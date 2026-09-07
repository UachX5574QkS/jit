import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { QueryResultRow } from 'pg';
import { DbCredentialLoader } from './credential-loader.js';
import type { Queryable } from '../db/query.js';

/**
 * DB-free unit tests for {@link DbCredentialLoader} (design: "Auth & identity",
 * R1.4; "Passwords", R1.5). A fake `Queryable` records the SQL text and params,
 * so the tests assert the parameterised lookup and mapping without a live
 * database — matching the project's injectable test style.
 */

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

describe('DbCredentialLoader.loadByUsername', () => {
  it('returns the id and stored hash for a known username', async () => {
    const { db, calls } = fakeQueryable([{ id: 42, password_hash: '$2b$12$abc' }]);
    const loader = new DbCredentialLoader(db);

    const credential = await loader.loadByUsername('11111111');

    assert.deepEqual(credential, { id: 42, passwordHash: '$2b$12$abc' });
    // The username value must travel as a bound parameter, never interpolated.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, ['11111111']);
    assert.match(calls[0].text, /\$1/);
    assert.match(calls[0].text, /password_hash/);
  });

  it('returns null when no account matches the username', async () => {
    const { db } = fakeQueryable([]);
    const loader = new DbCredentialLoader(db);
    assert.equal(await loader.loadByUsername('99999999'), null);
  });
});
