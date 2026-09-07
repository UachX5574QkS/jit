import { config } from '../config/env.js';

/**
 * Injectable client for the locally running Ollama service used by
 * `POST /api/review/summary` (design: "Ollama Integration", R2.11–2.12).
 *
 * ── Why an interface + a fetch implementation ────────────────────────────────
 * The `/review/summary` handler depends on this narrow {@link OllamaClient}
 * interface, never on `fetch`/the network directly, so it unit-tests with an
 * in-memory fake — matching the injectable style used by the workflow-support,
 * team-admin and data-point stores. The production {@link HttpOllamaClient} is
 * the only place that talks to the model over HTTP, and it enforces the short
 * timeout via an {@link AbortController} so a slow/absent model degrades to the
 * entered-values fallback quickly (R2.12) rather than stalling Step 3.
 *
 * ── Display-only, never persisted ────────────────────────────────────────────
 * The summary is purely for display on Step 3. Neither this client nor the
 * handler writes anything to the database — there is no store, no transaction
 * and no audit here by design (R2.12: the fallback still allows submission, and
 * submission itself is a separate endpoint, task 6.3).
 */

/** The prompt the handler hands to the model to summarise a request. */
export interface OllamaSummaryPrompt {
  /** The task version the values were entered against (for context/logging). */
  readonly taskVersionId: number;
  /** The prompt text describing the entered request for the model to summarise. */
  readonly prompt: string;
}

/** The narrow contract the `/review/summary` handler depends on. */
export interface OllamaClient {
  /**
   * Ask the model to generate a short summary. Resolves to the summary text on
   * success. On ANY error or timeout it MUST reject (or otherwise signal
   * failure by throwing) so the handler can apply the entered-values fallback
   * (R2.12); it must never hang past the configured timeout.
   */
  generateSummary(prompt: OllamaSummaryPrompt): Promise<string>;
}

/** Shape of the relevant part of Ollama's `/api/generate` (non-streaming) reply. */
interface OllamaGenerateResponse {
  readonly response?: unknown;
}

/**
 * Production {@link OllamaClient} backed by the local Ollama HTTP API. Calls the
 * non-streaming `/api/generate` endpoint and aborts after the configured
 * timeout so the handler falls back promptly when the model is slow or down.
 *
 * The `fetchImpl`/`baseUrl`/`model`/`timeoutMs` seams default to the global
 * fetch and the {@link config} values; tests inject their own.
 */
export class HttpOllamaClient implements OllamaClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options?: {
    baseUrl?: string;
    model?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
  }) {
    this.baseUrl = options?.baseUrl ?? config.ollama.baseUrl;
    this.model = options?.model ?? config.ollama.model;
    this.timeoutMs = options?.timeoutMs ?? config.ollama.timeoutMs;
    this.fetchImpl = options?.fetchImpl ?? fetch;
  }

  async generateSummary(prompt: OllamaSummaryPrompt): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          prompt: prompt.prompt,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`Ollama responded with HTTP ${res.status}`);
      }

      const body = (await res.json()) as OllamaGenerateResponse;
      const summary = typeof body.response === 'string' ? body.response.trim() : '';
      if (summary.length === 0) {
        throw new Error('Ollama returned an empty summary');
      }
      return summary;
    } finally {
      clearTimeout(timer);
    }
  }
}
