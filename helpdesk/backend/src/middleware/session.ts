import type { RequestHandler } from 'express';
import { config } from '../config/env.js';

/**
 * Placeholder for the dev session mechanism.
 *
 * The dev login (subtask 4.1) establishes an HTTP-only session cookie; this
 * middleware will resolve that cookie into a session on the request. In the
 * future ORDS/IDCS deployment it is replaced by IDCS token validation, behind
 * the same `CurrentUser` abstraction (subtask 3.2). For now it is a no-op that
 * simply makes the configured cookie name available to downstream handlers.
 */
export const sessionMiddleware: RequestHandler = (req, _res, next) => {
  // Intentionally minimal: cookie parsing is wired in app.ts via cookie-parser.
  // Resolving the cookie into an authenticated principal is done in later tasks.
  void config.session.cookieName;
  void req;
  next();
};
