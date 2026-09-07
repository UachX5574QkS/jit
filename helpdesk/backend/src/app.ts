import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import { config } from './config/env.js';
import { pingDatabase } from './db/pool.js';
import { sessionMiddleware } from './middleware/session.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { apiRouter } from './routes/index.js';

/**
 * Builds the Express application: cross-cutting middleware, the health check,
 * the `/api` router skeleton, and the uniform error handling. Feature endpoints
 * are added by later tasks onto the routers under `routes/`.
 */
export function createApp(): Express {
  const app = express();

  // CORS for local dev: allow the Angular dev server with credentials so the
  // HTTP-only session cookie flows during development.
  app.use(
    cors({
      origin: config.corsOrigins,
      credentials: true,
    }),
  );

  // JSON body parsing and cookie parsing (dev session cookie).
  app.use(express.json());
  app.use(cookieParser(config.session.secret));

  // Session resolution placeholder (real logic added in later tasks).
  app.use(sessionMiddleware);

  // Health check — verifies the process is up and reports DB connectivity.
  app.get('/health', async (_req, res) => {
    const dbUp = await pingDatabase();
    res.status(200).json({
      status: 'ok',
      service: 'helpdesk-backend',
      database: dbUp ? 'up' : 'down',
      timestamp: new Date().toISOString(),
    });
  });

  // Feature API surface (skeleton).
  app.use('/api', apiRouter);

  // Fallthrough handlers producing the uniform error envelope.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
