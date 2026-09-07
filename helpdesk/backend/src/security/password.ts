import { compare, getRounds, hash, truncates } from 'bcryptjs';

/**
 * Password hashing helpers (design: cross-cutting "Passwords" decision, R1.5).
 *
 * ── What this module guarantees ──────────────────────────────────────────────
 * Passwords are protected with bcrypt — a deliberately slow, salted, one-way
 * key-derivation function. The design permits bcrypt or argon2; we use bcrypt
 * via `bcryptjs`, a pure-JavaScript implementation with no native build step so
 * the backend installs and runs on a fresh laptop offline.
 *
 * Being one-way, a stored hash cannot be reversed to recover the plaintext
 * (R1.5). The plaintext is only ever a transient function argument here; it is
 * never persisted, returned, or logged by this module.
 *
 * ── Handling rules for callers ───────────────────────────────────────────────
 *   • Store ONLY the string returned by {@link hashPassword} in
 *     `app_user.password_hash`. Never store the plaintext.
 *   • Verify logins with {@link verifyPassword}; never compare hashes with `===`
 *     (bcrypt embeds a per-hash random salt, so equal passwords hash to
 *     different strings, and `compare` is constant-time).
 *   • Never SELECT `password_hash` into an API response and never write a
 *     plaintext password or a hash to a log line. This module intentionally
 *     exposes no "reveal" or "decrypt" function because none can exist.
 */

/**
 * bcrypt cost factor (log2 of the number of rounds). Each +1 doubles the work.
 * 12 is a sensible modern default: strong against offline cracking while
 * keeping a single hash well under ~250 ms on typical dev hardware.
 */
export const BCRYPT_COST = 12;

/**
 * bcrypt hashes at most the first 72 bytes of a UTF-8 password; any excess is
 * silently ignored. We reject over-long inputs rather than let two different
 * passwords that share a 72-byte prefix authenticate interchangeably.
 */
const MAX_PASSWORD_BYTES = 72;

/**
 * Hash a plaintext password for storage.
 *
 * A fresh random salt is generated per call and embedded in the returned
 * modular-crypt string (`$2b$<cost>$<salt><digest>`), so the same password
 * hashes to a different value every time. Store the returned string verbatim.
 *
 * @param plaintext the user's password; used transiently and never retained.
 * @returns the bcrypt hash string suitable for `app_user.password_hash`.
 * @throws if the password is empty or exceeds bcrypt's 72-byte input limit.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  assertHashablePassword(plaintext);
  return hash(plaintext, BCRYPT_COST);
}

/**
 * Verify a candidate plaintext password against a stored bcrypt hash.
 *
 * Uses bcrypt's constant-time comparison to avoid leaking information through
 * timing. Returns `false` (never throws) for a malformed or non-bcrypt stored
 * hash, so a corrupt record fails closed as a rejected login rather than an
 * error.
 *
 * @param plaintext  the candidate password supplied at login.
 * @param storedHash the hash previously produced by {@link hashPassword}.
 * @returns `true` only when the password matches the hash.
 */
export async function verifyPassword(
  plaintext: string,
  storedHash: string,
): Promise<boolean> {
  if (!plaintext || !storedHash) {
    return false;
  }
  try {
    return await compare(plaintext, storedHash);
  } catch {
    // A malformed/unrecognised stored hash must fail closed, not error out.
    return false;
  }
}

/**
 * Report whether a stored hash was produced with a weaker cost factor than the
 * current {@link BCRYPT_COST} and should therefore be re-hashed on next login.
 *
 * This lets the cost factor be raised over time: on a successful login a caller
 * can transparently upgrade an older, cheaper hash. Returns `true` for a
 * malformed hash so it is treated as needing replacement.
 *
 * @param storedHash an existing bcrypt hash string.
 */
export function needsRehash(storedHash: string): boolean {
  try {
    const rounds = getRounds(storedHash);
    // `getRounds` yields NaN for a malformed hash instead of throwing; treat any
    // non-finite result as "unrecognised", hence needing replacement.
    if (!Number.isFinite(rounds)) {
      return true;
    }
    return rounds < BCRYPT_COST;
  } catch {
    return true;
  }
}

/**
 * Guard against inputs bcrypt cannot faithfully hash.
 *
 * @throws if the password is empty or longer than 72 UTF-8 bytes.
 */
function assertHashablePassword(plaintext: string): void {
  if (!plaintext) {
    throw new Error('Password must not be empty.');
  }
  if (truncates(plaintext)) {
    throw new Error(
      `Password must not exceed ${MAX_PASSWORD_BYTES} bytes when UTF-8 encoded.`,
    );
  }
}
