import type { Queryable } from '../db/query.js';
import { one } from '../db/query.js';
import { pool } from '../db/pool.js';

/**
 * Loads the credential facts needed to authenticate a login (design: "Auth &
 * identity", R1.3, R1.4; "Passwords", R1.5).
 *
 * This is the ONLY place the stored `password_hash` is read, and it is read
 * solely so {@link verifyPassword} can compare a candidate password against it.
 * The hash never leaves the login handler: it is not attached to the resolved
 * identity, returned in a response, or logged (R1.5). Once the login has been
 * verified, the rest of the request works only with the resolved
 * {@link import('./current-user.js').CurrentUser}.
 *
 * Like {@link import('./identity-loader.js').UserIdentityLoader}, this is an
 * interface so tests can inject an in-memory fake (keeping the login unit tests
 * database-free, matching the project's test style) and so the storage boundary
 * stays behind the parameterised data-access layer.
 */
export interface Credential {
  /** Surrogate `app_user.id` — the principal reference signed into the session. */
  readonly id: number;
  /** The stored bcrypt hash to verify the candidate password against. */
  readonly passwordHash: string;
}

export interface CredentialLoader {
  /**
   * Load the id and stored password hash for `username`, or `null` when no such
   * account exists. A `null` result and a wrong password are treated
   * identically by the login handler so the response does not reveal whether a
   * username exists.
   */
  loadByUsername(username: string): Promise<Credential | null>;
}

/** Row shape for the credential lookup (the one place `password_hash` is read). */
interface CredentialRow {
  readonly id: number;
  readonly password_hash: string;
}

/**
 * Postgres-backed {@link CredentialLoader}. Reads the id and stored hash for a
 * username through the parameterised data-access layer (R22.4). The `$1`
 * placeholder means the username value is never interpolated into SQL.
 */
export class DbCredentialLoader implements CredentialLoader {
  constructor(private readonly db: Queryable = pool) {}

  async loadByUsername(username: string): Promise<Credential | null> {
    const row = await one<CredentialRow>(
      `SELECT id, password_hash
         FROM app_user
        WHERE username = $1`,
      [username],
      this.db,
    );
    if (!row) {
      return null;
    }
    return { id: row.id, passwordHash: row.password_hash };
  }
}
