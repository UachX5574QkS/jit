import type { Request } from 'express';

/**
 * The swappable authentication seam (design: "Identity resolution", R1.7).
 *
 * An `AuthSource` inspects an incoming request and reports WHO the principal is
 * — expressed only as an opaque reference (the `app_user.id`) — or `null` when
 * the request carries no valid authentication. It deliberately knows nothing
 * about roles, teams, or the database: turning the reference into a full
 * {@link import('./current-user.js').CurrentUser} is the resolver's job.
 *
 * This is the ONE place the authentication mechanism lives. In development the
 * implementation reads the HTTP-only session cookie established by the dev
 * login ({@link DevSessionAuthSource}); in the future ORDS/IDCS deployment a
 * different implementation validates an IDCS token — and nothing else in the
 * backend changes, because feature code only ever reads the resolved
 * `CurrentUser` (R1.7, R22.4).
 */
export interface AuthSource {
  /**
   * Resolve the request to a principal reference (an `app_user.id`), or `null`
   * when the request is unauthenticated. Implementations MUST NOT throw for an
   * absent/invalid credential — an unauthenticated request is a normal outcome,
   * reported as `null`.
   */
  resolvePrincipalId(req: Request): number | null;
}

/**
 * Reads a signed principal id from a session cookie. This models the
 * development mechanism only: the dev login (task 4.1) establishes an HTTP-only
 * session cookie whose value is the signed `app_user.id`; here we read it back.
 *
 * `cookie-parser` is configured with the session secret in `app.ts`, so signed
 * cookies are exposed on `req.signedCookies` already verified — a tampered or
 * unsigned value is dropped by `cookie-parser` and simply appears absent here,
 * which we treat as unauthenticated.
 *
 * The IDCS replacement implements the same {@link AuthSource} interface, so
 * swapping mechanisms is a one-line wiring change in the resolver's
 * construction — feature code is untouched.
 */
export class DevSessionAuthSource implements AuthSource {
  constructor(private readonly cookieName: string) {}

  resolvePrincipalId(req: Request): number | null {
    const raw = req.signedCookies?.[this.cookieName];
    return parsePrincipalId(raw);
  }
}

/**
 * Parse a cookie value into a positive integer `app_user.id`, or `null` when it
 * is absent or not a well-formed positive integer. Kept separate (and exported)
 * so the parsing rule is unit-testable without constructing an Express request.
 */
export function parsePrincipalId(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }
  // Accept only a plain run of digits: rejects "1.5", "1e3", "0x1", " 1 ", etc.
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const id = Number(raw);
  // Guard against 0 and values beyond safe-integer precision.
  if (!Number.isSafeInteger(id) || id <= 0) {
    return null;
  }
  return id;
}
