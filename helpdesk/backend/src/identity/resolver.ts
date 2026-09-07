import type { Request } from 'express';
import type { AuthSource } from './auth-source.js';
import { DevSessionAuthSource } from './auth-source.js';
import type { UserIdentityLoader } from './identity-loader.js';
import { DbUserIdentityLoader } from './identity-loader.js';
import type { CurrentUser } from './current-user.js';
import { buildCurrentUser } from './current-user.js';
import { config } from '../config/env.js';

/**
 * Resolves an incoming request to a single {@link CurrentUser} (design:
 * "Identity resolution", R1.3, R1.7, R22.4).
 *
 * The resolver composes the two swappable pieces:
 *   1. an {@link AuthSource} that says WHO the principal is (dev session cookie
 *      now; IDCS token later) as an opaque `app_user.id`, and
 *   2. a {@link UserIdentityLoader} that turns that id into the raw identity
 *      facts (core record, teams led, teams member of, admin membership).
 *
 * It then delegates to the pure {@link buildCurrentUser} to derive the additive
 * role superset and the display name. Because both pieces are injected, the
 * authentication mechanism can change (dev → IDCS) without altering this class
 * or any feature code: everything downstream reads only the resolved
 * `CurrentUser` (R1.7).
 */
export class CurrentUserResolver {
  constructor(
    private readonly authSource: AuthSource,
    private readonly identityLoader: UserIdentityLoader,
  ) {}

  /**
   * Resolve the request to a `CurrentUser`, or `null` when the request is
   * unauthenticated OR references a principal that no longer exists (a stale
   * session). Callers that require authentication should treat `null` as a
   * 401/redirect-to-login; the authorisation middleware (task 3.3) builds on
   * this.
   */
  async resolve(req: Request): Promise<CurrentUser | null> {
    const principalId = this.authSource.resolvePrincipalId(req);
    if (principalId === null) {
      return null;
    }
    const identity = await this.identityLoader.load(principalId);
    if (identity === null) {
      return null;
    }
    return buildCurrentUser(identity);
  }
}

/**
 * Build the resolver wired for the current runtime. Development uses the
 * signed session cookie and the Postgres-backed loader. Swapping to IDCS later
 * means constructing this with an `IdcsAuthSource` in place of
 * {@link DevSessionAuthSource} — a single change confined to this factory.
 */
export function createCurrentUserResolver(): CurrentUserResolver {
  return new CurrentUserResolver(
    new DevSessionAuthSource(config.session.cookieName),
    new DbUserIdentityLoader(),
  );
}
