import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Express } from 'express';
import { errorHandler } from '../middleware/errors.js';
import type { CurrentUser } from '../identity/current-user.js';
import {
  createEstimatedEffortRouter,
  serializeEstimatedEffort,
} from './requests-estimated-effort.routes.js';
import {
  TaskNotFoundError,
  type EstimatedEffortStore,
  type EstimatedEffortView,
} from './requests-estimated-effort.store.js';

/**
 * Tests for the Estimated-Effort route layer (design: "Requests (user side)" —
 * `GET /api/tasks/{taskId}/estimated-effort` — type-level average; R4.7). These
 * exercise the `:taskId` param parsing, the response envelope, the null-estimate
 * pass-through, and the unknown-task → 404 mapping. The store is a hand-rolled
 * fake so no database is touched — matching the injectable-store route style.
 */

function view(overrides: Partial<EstimatedEffortView> = {}): EstimatedEffortView {
  return {
    taskId: 42,
    completedCount: 3,
    totalSliceMinutes: 180,
    estimatedEffortMinutes: 60,
    ...overrides,
  };
}

/** A fake store that records the task id it was called with, or throws when configured to. */
function fakeStore(
  result: EstimatedEffortView | TaskNotFoundError,
): EstimatedEffortStore & { last: () => number | null } {
  let last: number | null = null;
  return {
    getEstimatedEffort: async (taskId) => {
      last = taskId;
      if (result instanceof TaskNotFoundError) {
        throw result;
      }
      return result;
    },
    last: () => last,
  };
}

function stubUser(id: number): CurrentUser {
  return {
    id,
    username: '11111111',
    displayName: 'Test User',
    roles: new Set(['USER']),
    teamsLed: [],
    teamsMemberOf: [],
    isAdmin: false,
    timezone: null,
  };
}

function appWith(store: EstimatedEffortStore, userId = 100): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.currentUser = stubUser(userId);
    next();
  });
  app.use('/api', createEstimatedEffortRouter(store));
  app.use(errorHandler);
  return app;
}

async function get(
  app: Express,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { createServer } = await import('node:http');
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`);
    const parsed = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body: parsed };
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ── Serialisation (unit) ─────────────────────────────────────────────────────────

describe('serializeEstimatedEffort (R4.7, R4.9)', () => {
  it('maps the view to camelCase JSON, preserving a numeric estimate', () => {
    assert.deepEqual(serializeEstimatedEffort(view()), {
      taskId: 42,
      completedCount: 3,
      totalSliceMinutes: 180,
      estimatedEffortMinutes: 60,
    });
  });

  it('preserves a null estimate', () => {
    assert.deepEqual(
      serializeEstimatedEffort(
        view({ completedCount: 0, totalSliceMinutes: 0, estimatedEffortMinutes: null }),
      ),
      {
        taskId: 42,
        completedCount: 0,
        totalSliceMinutes: 0,
        estimatedEffortMinutes: null,
      },
    );
  });
});

// ── GET /tasks/:taskId/estimated-effort (integration through the router) ─────────

describe('GET /api/tasks/:taskId/estimated-effort (R4.7)', () => {
  it('returns the type-level average for a known task', async () => {
    const store = fakeStore(view());
    const app = appWith(store, 100);

    const res = await get(app, '/api/tasks/42/estimated-effort');

    assert.equal(res.status, 200);
    assert.equal(store.last(), 42);
    assert.deepEqual(res.body, {
      taskId: 42,
      completedCount: 3,
      totalSliceMinutes: 180,
      estimatedEffortMinutes: 60,
    });
  });

  it('returns a null estimate cleanly when the type has no complete requests', async () => {
    const store = fakeStore(
      view({ completedCount: 0, totalSliceMinutes: 0, estimatedEffortMinutes: null }),
    );
    const app = appWith(store, 100);

    const res = await get(app, '/api/tasks/42/estimated-effort');

    assert.equal(res.status, 200);
    assert.equal(res.body['completedCount'], 0);
    assert.equal(res.body['estimatedEffortMinutes'], null);
  });

  it('maps an unknown task to 404 NOT_FOUND', async () => {
    const store = fakeStore(new TaskNotFoundError(999));
    const app = appWith(store, 100);

    const res = await get(app, '/api/tasks/999/estimated-effort');

    assert.equal(res.status, 404);
    const err = res.body['error'] as Record<string, unknown>;
    assert.equal(err['code'], 'NOT_FOUND');
    assert.deepEqual(err['details'], { taskId: 999 });
  });

  it('rejects a malformed task id with 400 VALIDATION_FAILED', async () => {
    const store = fakeStore(view());
    const app = appWith(store, 100);

    const res = await get(app, '/api/tasks/abc/estimated-effort');

    assert.equal(res.status, 400);
    assert.equal((res.body['error'] as Record<string, unknown>)['code'], 'VALIDATION_FAILED');
  });
});
