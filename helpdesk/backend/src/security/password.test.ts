import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BCRYPT_COST,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password.js';

// bcrypt at cost 12 is deliberately slow; give the KDF room on slower CI boxes.
const KDF_TIMEOUT_MS = 20_000;

describe('hashPassword', () => {
  it('produces a bcrypt modular-crypt hash, not the plaintext', async (t) => {
    t.diagnostic('R1.5 — passwords stored one-way, never as plaintext');
    const hash = await hashPassword('password1');
    // bcrypt hashes start with $2a$/$2b$/$2y$ followed by the two-digit cost.
    assert.match(hash, /^\$2[aby]\$\d{2}\$/);
    assert.notEqual(hash, 'password1');
    assert.ok(!hash.includes('password1'));
  });

  it('embeds the configured cost factor in the hash', { timeout: KDF_TIMEOUT_MS }, async () => {
    const hash = await hashPassword('password1');
    const cost = Number(hash.split('$')[2]);
    assert.equal(cost, BCRYPT_COST);
  });

  it('is salted: the same password hashes to different values each time', { timeout: KDF_TIMEOUT_MS }, async () => {
    const a = await hashPassword('password1');
    const b = await hashPassword('password1');
    assert.notEqual(a, b);
  });

  it('rejects an empty password', async () => {
    await assert.rejects(() => hashPassword(''), /must not be empty/);
  });

  it("rejects a password longer than bcrypt's 72-byte input limit", async () => {
    await assert.rejects(() => hashPassword('a'.repeat(73)), /72 bytes/);
  });
});

describe('verifyPassword', () => {
  it('returns true for the correct password', { timeout: KDF_TIMEOUT_MS }, async () => {
    const hash = await hashPassword('password1');
    assert.equal(await verifyPassword('password1', hash), true);
  });

  it('returns false for an incorrect password', { timeout: KDF_TIMEOUT_MS }, async () => {
    const hash = await hashPassword('password1');
    assert.equal(await verifyPassword('wrong-password', hash), false);
  });

  it('is case-sensitive', { timeout: KDF_TIMEOUT_MS }, async () => {
    const hash = await hashPassword('Password1');
    assert.equal(await verifyPassword('password1', hash), false);
  });

  it('verifies a distinct hash of the same password (salt independence)', { timeout: KDF_TIMEOUT_MS }, async () => {
    const a = await hashPassword('password1');
    const b = await hashPassword('password1');
    assert.notEqual(a, b);
    assert.equal(await verifyPassword('password1', a), true);
    assert.equal(await verifyPassword('password1', b), true);
  });

  it('fails closed (false, no throw) for a malformed stored hash', async () => {
    assert.equal(await verifyPassword('password1', 'not-a-bcrypt-hash'), false);
  });

  it('returns false for empty inputs rather than throwing', async () => {
    assert.equal(await verifyPassword('', ''), false);
    assert.equal(await verifyPassword('password1', ''), false);
    assert.equal(await verifyPassword('', 'anything'), false);
  });
});

describe('needsRehash', () => {
  it('is false for a hash at the current cost factor', { timeout: KDF_TIMEOUT_MS }, async () => {
    const hash = await hashPassword('password1');
    assert.equal(needsRehash(hash), false);
  });

  it('is true for a hash produced with a weaker cost factor', () => {
    // A valid bcrypt hash at cost 04 (well below BCRYPT_COST).
    const weakHash =
      '$2a$04$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
    assert.ok(BCRYPT_COST > 4);
    assert.equal(needsRehash(weakHash), true);
  });

  it('is true (treat as needing replacement) for a malformed hash', () => {
    assert.equal(needsRehash('garbage'), true);
  });
});
