import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';
import { DevSessionAuthSource, parsePrincipalId } from './auth-source.js';

describe('parsePrincipalId', () => {
  it('parses a plain positive-integer string', () => {
    assert.equal(parsePrincipalId('42'), 42);
    assert.equal(parsePrincipalId('1'), 1);
  });

  it('returns null for a missing value', () => {
    assert.equal(parsePrincipalId(undefined), null);
    assert.equal(parsePrincipalId(null), null);
    assert.equal(parsePrincipalId(''), null);
    assert.equal(parsePrincipalId('   '), null);
  });

  it('returns null for zero and negative ids', () => {
    assert.equal(parsePrincipalId('0'), null);
    assert.equal(parsePrincipalId('-1'), null);
  });

  it('returns null for non-integer numeric forms', () => {
    assert.equal(parsePrincipalId('1.5'), null);
    assert.equal(parsePrincipalId('1e3'), null);
    assert.equal(parsePrincipalId('0x1'), null);
    assert.equal(parsePrincipalId(' 1 '), null);
  });

  it('returns null for non-string inputs', () => {
    assert.equal(parsePrincipalId(42), null);
    assert.equal(parsePrincipalId({ id: 1 }), null);
  });

  it('returns null beyond safe-integer precision', () => {
    assert.equal(parsePrincipalId('9007199254740993'), null);
  });
});

/** Build a minimal request carrying only the signed cookies map. */
function reqWithSignedCookies(signedCookies: Record<string, unknown>): Request {
  return { signedCookies } as unknown as Request;
}

describe('DevSessionAuthSource', () => {
  const cookieName = 'helpdesk_sid';
  const source = new DevSessionAuthSource(cookieName);

  it('resolves the principal id from the signed session cookie', () => {
    const req = reqWithSignedCookies({ [cookieName]: '7' });
    assert.equal(source.resolvePrincipalId(req), 7);
  });

  it('returns null when the session cookie is absent', () => {
    assert.equal(source.resolvePrincipalId(reqWithSignedCookies({})), null);
  });

  it('does not throw and returns null when signedCookies is undefined', () => {
    const req = {} as unknown as Request;
    assert.equal(source.resolvePrincipalId(req), null);
  });

  it('ignores a cookie under a different name', () => {
    const req = reqWithSignedCookies({ other: '7' });
    assert.equal(source.resolvePrincipalId(req), null);
  });

  it('returns null for a malformed cookie value (e.g. tampered)', () => {
    const req = reqWithSignedCookies({ [cookieName]: 'not-a-number' });
    assert.equal(source.resolvePrincipalId(req), null);
  });
});
