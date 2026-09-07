import { Router } from 'express';
import { authRouter } from './auth.routes.js';
import { requestsRouter } from './requests.routes.js';
import { supportRouter } from './support.routes.js';
import { statsRouter } from './stats.routes.js';
import { adminRouter } from './admin.routes.js';
import { authenticate } from '../middleware/authorize.js';

/**
 * Root API router mounted at `/api`.
 *
 * The feature areas below mirror the API surface in the design document. Each
 * sub-router is a placeholder wired into the app so later tasks can add the
 * real handlers without touching the app bootstrap. No feature endpoints are
 * implemented here beyond auth (that is later work) — only the routing
 * structure.
 *
 * ── Authentication boundary (design: "API Design") ───────────────────────────
 * Every `/api` endpoint requires an authenticated principal EXCEPT the auth
 * entry points. The auth router is mounted first and owns its own access
 * control (`/login` and `/logout` are public; `/me` authenticates internally),
 * then the global {@link authenticate} middleware runs so every subsequent
 * feature router requires a valid session — a request without one is rejected
 * with 401 before reaching any feature handler (R1.8). Feature routers below
 * therefore assume `req.currentUser` is always present.
 */
export const apiRouter = Router();

// Public auth entry points (self-guarded where needed).
apiRouter.use('/auth', authRouter);

// From here on, every /api route requires an authenticated principal.
apiRouter.use(authenticate);

apiRouter.use('/', requestsRouter); // /requests, /tasks, /teams, /review
apiRouter.use('/support', supportRouter);
apiRouter.use('/stats', statsRouter);
apiRouter.use('/', adminRouter); // /admin, /team-leader
