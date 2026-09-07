import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HttpOllamaClient } from './ollama-client.js';

/**
 * Tests for the HTTP-backed Ollama client (design: "Ollama Integration",
 * R2.11–2.12). A fake `fetch` is injected so the success mapping, the
 * short-timeout abort, and the error handling are exercised WITHOUT a live
 * model or network — matching the injectable style used across the backend.
 */

/** Build a fake `fetch` returning the given JSON body with the given status. */
function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

describe('HttpOllamaClient.generateSummary (R2.11)', () => {
  it('posts to /api/generate and returns the trimmed response text', async () => {
    let capturedUrl: string | undefined;
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ response: '  A summary.  ' }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const client = new HttpOllamaClient({
      baseUrl: 'http://localhost:11434',
      model: 'test-model',
      timeoutMs: 1000,
      fetchImpl,
    });

    const summary = await client.generateSummary({ taskVersionId: 1, prompt: 'p' });

    assert.equal(summary, 'A summary.');
    assert.equal(capturedUrl, 'http://localhost:11434/api/generate');
    const sentBody = JSON.parse(String(capturedInit?.body)) as {
      model: string;
      prompt: string;
      stream: boolean;
    };
    assert.equal(sentBody.model, 'test-model');
    assert.equal(sentBody.prompt, 'p');
    assert.equal(sentBody.stream, false);
    assert.ok(capturedInit?.signal, 'an abort signal must be supplied for the timeout');
  });
});

describe('HttpOllamaClient.generateSummary — failures (R2.12)', () => {
  it('throws on a non-2xx HTTP status', async () => {
    const client = new HttpOllamaClient({ fetchImpl: fakeFetch(503, {}), timeoutMs: 1000 });
    await assert.rejects(() => client.generateSummary({ taskVersionId: 1, prompt: 'p' }));
  });

  it('throws on an empty/missing response field', async () => {
    const client = new HttpOllamaClient({
      fetchImpl: fakeFetch(200, { response: '   ' }),
      timeoutMs: 1000,
    });
    await assert.rejects(() => client.generateSummary({ taskVersionId: 1, prompt: 'p' }));
  });

  it('rejects when the request exceeds the configured timeout', async () => {
    // A fetch that only settles when its abort signal fires, so the client's
    // short timeout is what ends the call (models a slow/unavailable Ollama).
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;

    const client = new HttpOllamaClient({ fetchImpl, timeoutMs: 10 });
    await assert.rejects(() => client.generateSummary({ taskVersionId: 1, prompt: 'p' }));
  });
});
