import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import { ApiError } from '../middleware/errors.js';
import {
  buildSummaryPrompt,
  createReviewSummaryHandler,
  parseReviewSummaryBody,
} from './review.routes.js';
import type { OllamaClient, OllamaSummaryPrompt } from './ollama-client.js';

/**
 * Tests for the New-workflow Step 3 review summary endpoint (design: "Ollama
 * Integration", R2.11–2.12). The handler is invoked directly with fake
 * req/res/next and an INJECTED fake {@link OllamaClient} — no HTTP server, no
 * live model, no database — matching the project's injectable, DB-free
 * unit-test style.
 *
 * The three behaviours the design pins down are covered:
 *   1. Ollama available  → `{ available: true, summary }` (R2.11).
 *   2. Ollama error/timeout → `{ available: false }` echoing the entered values
 *      so the frontend can display them and still allow submission (R2.12).
 *   3. Display-only: the endpoint has no store/db dependency, so a summary call
 *      cannot mutate anything — asserted structurally by the fake client only
 *      being asked to generate, and by both paths returning 200 without any
 *      persistence seam existing to touch.
 */

// ── Fakes ──────────────────────────────────────────────────────────────────────

/** A fake Ollama client that records prompts and returns a canned summary. */
class FakeOllamaClient implements OllamaClient {
  readonly prompts: OllamaSummaryPrompt[] = [];
  constructor(private readonly summary: string) {}
  async generateSummary(prompt: OllamaSummaryPrompt): Promise<string> {
    this.prompts.push(prompt);
    return this.summary;
  }
}

/** A fake Ollama client that always fails (models a timeout/outage). */
class FailingOllamaClient implements OllamaClient {
  readonly prompts: OllamaSummaryPrompt[] = [];
  constructor(private readonly error: Error = new Error('timeout')) {}
  async generateSummary(prompt: OllamaSummaryPrompt): Promise<string> {
    this.prompts.push(prompt);
    throw this.error;
  }
}

/** A minimal fake response recording status and JSON body. */
interface FakeRes {
  statusCode?: number;
  body?: unknown;
  res: Response;
  onDone?: () => void;
}

function fakeResponse(): FakeRes {
  const state: FakeRes = { res: undefined as unknown as Response };
  state.res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      state.onDone?.();
      return this;
    },
  } as unknown as Response;
  return state;
}

/** Invoke a handler, settling on `next(err)` or a terminal `json()`. */
function invoke(
  handler: (req: Request, res: Response, next: (err?: unknown) => void) => void,
  req: Partial<Request>,
  fake: FakeRes,
): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (err: unknown) => {
      if (!settled) {
        settled = true;
        resolve(err);
      }
    };
    fake.onDone = () => settle(undefined);
    handler(req as Request, fake.res, (err?: unknown) => settle(err));
  });
}

function reqWithBody(body: unknown): Partial<Request> {
  return { body, params: {}, currentUser: { id: 7 } as Request['currentUser'] };
}

// ── parseReviewSummaryBody ──────────────────────────────────────────────────────

describe('parseReviewSummaryBody', () => {
  it('accepts a well-formed body and normalises values', () => {
    const parsed = parseReviewSummaryBody({
      taskVersionId: 55,
      values: [
        { taskFieldId: 1, name: 'Full Name', value: 'Ada Lovelace' },
        { taskFieldId: 2, value: 42 },
        { taskFieldId: 3, name: 'Notes', value: null },
      ],
    });
    assert.equal(parsed.taskVersionId, 55);
    assert.deepEqual(parsed.values, [
      { taskFieldId: 1, name: 'Full Name', value: 'Ada Lovelace' },
      { taskFieldId: 2, name: null, value: '42' },
      { taskFieldId: 3, name: 'Notes', value: '' },
    ]);
  });

  it('accepts a numeric-string taskVersionId', () => {
    const parsed = parseReviewSummaryBody({ taskVersionId: '55', values: [] });
    assert.equal(parsed.taskVersionId, 55);
  });

  it('rejects a missing/invalid taskVersionId', () => {
    for (const bad of [undefined, null, 0, -1, 'abc', {}]) {
      assert.throws(
        () => parseReviewSummaryBody({ taskVersionId: bad, values: [] }),
        (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
      );
    }
  });

  it('rejects a non-array values field', () => {
    assert.throws(
      () => parseReviewSummaryBody({ taskVersionId: 1, values: 'nope' }),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });

  it('rejects a value entry without a valid taskFieldId', () => {
    assert.throws(
      () => parseReviewSummaryBody({ taskVersionId: 1, values: [{ value: 'x' }] }),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });

  it('rejects a non-object body', () => {
    assert.throws(
      () => parseReviewSummaryBody(null),
      (e) => e instanceof ApiError && e.code === 'VALIDATION_FAILED',
    );
  });
});

// ── buildSummaryPrompt ──────────────────────────────────────────────────────────

describe('buildSummaryPrompt', () => {
  it('lists each entered value on its own labelled line', () => {
    const prompt = buildSummaryPrompt({
      taskVersionId: 1,
      values: [
        { taskFieldId: 1, name: 'Full Name', value: 'Ada' },
        { taskFieldId: 2, name: 'Cost Centre', value: 'CC-9' },
      ],
    });
    assert.match(prompt, /- Full Name: Ada/);
    assert.match(prompt, /- Cost Centre: CC-9/);
  });

  it('omits blank values and labels unnamed fields by id', () => {
    const prompt = buildSummaryPrompt({
      taskVersionId: 1,
      values: [
        { taskFieldId: 1, name: null, value: 'kept' },
        { taskFieldId: 2, name: 'Empty', value: '   ' },
      ],
    });
    assert.match(prompt, /- Field 1: kept/);
    assert.doesNotMatch(prompt, /Empty/);
  });

  it('degrades to a placeholder when nothing was entered', () => {
    const prompt = buildSummaryPrompt({ taskVersionId: 1, values: [] });
    assert.match(prompt, /no details entered/);
  });
});

// ── Handler: success (R2.11) ────────────────────────────────────────────────────

describe('createReviewSummaryHandler — Ollama available (R2.11)', () => {
  it('returns the generated summary with available:true', async () => {
    const client = new FakeOllamaClient('A concise summary.');
    const handler = createReviewSummaryHandler(client);
    const fake = fakeResponse();

    const err = await invoke(
      handler,
      reqWithBody({
        taskVersionId: 55,
        values: [{ taskFieldId: 1, name: 'Full Name', value: 'Ada' }],
      }),
      fake,
    );

    assert.equal(err, undefined);
    assert.equal(fake.statusCode, 200);
    assert.deepEqual(fake.body, {
      available: true,
      taskVersionId: 55,
      summary: 'A concise summary.',
    });
    // The model was called server-side exactly once, with a prompt built from
    // the entered values.
    assert.equal(client.prompts.length, 1);
    assert.equal(client.prompts[0]?.taskVersionId, 55);
    assert.match(client.prompts[0]?.prompt ?? '', /Full Name: Ada/);
  });
});

// ── Handler: fallback on error/timeout (R2.12) ──────────────────────────────────

describe('createReviewSummaryHandler — Ollama unavailable (R2.12)', () => {
  it('returns available:false and echoes the entered values on failure', async () => {
    const client = new FailingOllamaClient(new Error('aborted: timeout'));
    const handler = createReviewSummaryHandler(client);
    const fake = fakeResponse();

    const values = [
      { taskFieldId: 1, name: 'Full Name', value: 'Ada' },
      { taskFieldId: 2, name: 'Cost Centre', value: 'CC-9' },
    ];

    const err = await invoke(handler, reqWithBody({ taskVersionId: 55, values }), fake);

    assert.equal(err, undefined);
    // Still a 200 so the frontend proceeds and allows submission (R2.12).
    assert.equal(fake.statusCode, 200);
    assert.deepEqual(fake.body, {
      available: false,
      taskVersionId: 55,
      values: [
        { taskFieldId: 1, name: 'Full Name', value: 'Ada' },
        { taskFieldId: 2, name: 'Cost Centre', value: 'CC-9' },
      ],
    });
    // The model was attempted (server-side), then we degraded gracefully.
    assert.equal(client.prompts.length, 1);
  });

  it('does not surface the model error to next() — the workflow is never blocked', async () => {
    const client = new FailingOllamaClient();
    const handler = createReviewSummaryHandler(client);
    const fake = fakeResponse();

    const err = await invoke(
      handler,
      reqWithBody({ taskVersionId: 7, values: [] }),
      fake,
    );

    assert.equal(err, undefined);
    assert.equal(fake.statusCode, 200);
    assert.equal((fake.body as { available: boolean }).available, false);
  });
});

// ── Display-only / not persisted (R2.12) ────────────────────────────────────────

describe('createReviewSummaryHandler — display-only, not persisted (R2.12)', () => {
  it('reads the body and calls only the model; there is no store/db seam to mutate', async () => {
    // The handler is constructed from a single dependency: the Ollama client.
    // It exposes no store, transaction runner, or audit writer, so a summary
    // call has nothing to persist against — verified here by exercising both a
    // success and a failure path against clients that ONLY generate, and
    // asserting neither path invokes anything beyond generateSummary.
    const okClient = new FakeOllamaClient('summary');
    const okHandler = createReviewSummaryHandler(okClient);
    const okFake = fakeResponse();
    await invoke(okHandler, reqWithBody({ taskVersionId: 1, values: [] }), okFake);
    assert.equal(okClient.prompts.length, 1);
    assert.equal(okFake.statusCode, 200);

    const failClient = new FailingOllamaClient();
    const failHandler = createReviewSummaryHandler(failClient);
    const failFake = fakeResponse();
    await invoke(failHandler, reqWithBody({ taskVersionId: 1, values: [] }), failFake);
    assert.equal(failClient.prompts.length, 1);
    assert.equal(failFake.statusCode, 200);
  });
});
