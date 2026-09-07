import { Router, type RequestHandler } from 'express';
import { errors } from '../middleware/errors.js';
import { HttpOllamaClient, type OllamaClient } from './ollama-client.js';

/**
 * New-workflow Step 3 review summary endpoint (design: "Ollama Integration",
 * "Workflow support"; R2.11–2.12).
 *
 *   POST /api/review/summary   { taskVersionId, values } → summary | fallback
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 * Step 3 shows the raiser a generated summary of what they entered before they
 * submit. The summary is produced by the locally running Ollama service, called
 * SERVER-SIDE (via the injected {@link OllamaClient}) so the model endpoint
 * never touches the browser and the future ORDS move is a reimplementation of
 * the same contract. On success the handler returns `{ available: true }` with
 * the generated summary (R2.11).
 *
 * ── Graceful fallback (R2.12) ────────────────────────────────────────────────
 * The client enforces a short timeout; on ANY error or timeout it throws, and
 * this handler catches it and returns `{ available: false }` together with the
 * echoed entered values so the frontend can display those values instead and
 * STILL allow submission. An Ollama outage therefore never blocks the workflow.
 *
 * ── Display-only, never persisted ────────────────────────────────────────────
 * This endpoint reads nothing from and writes nothing to the database: there is
 * no store, no transaction and no audit. It is purely a display aid — the actual
 * request is created by a separate submit endpoint (task 6.3). Any authenticated
 * user may call it (every user may raise a request, R2.1); the global
 * {@link authenticate} middleware mounted ahead of the requests router already
 * rejects unauthenticated callers, so no per-route role guard is needed.
 */

/** One entered value echoed back to the frontend on the fallback path (R2.12). */
export interface ReviewValueJson {
  /** The task_field id the value was entered against. */
  readonly taskFieldId: number;
  /** The field label, when the caller supplied it (for display). */
  readonly name: string | null;
  /** The raw entered value as a string (may be empty for skipped optionals). */
  readonly value: string;
}

/** Successful summary response (Ollama available, R2.11). */
export interface ReviewSummaryAvailableJson {
  readonly available: true;
  readonly taskVersionId: number;
  readonly summary: string;
}

/** Fallback response (Ollama unavailable): echo the entered values (R2.12). */
export interface ReviewSummaryFallbackJson {
  readonly available: false;
  readonly taskVersionId: number;
  readonly values: ReviewValueJson[];
}

export type ReviewSummaryJson = ReviewSummaryAvailableJson | ReviewSummaryFallbackJson;

/** The validated request body: the task version plus the entered values. */
interface ReviewSummaryRequest {
  readonly taskVersionId: number;
  readonly values: ReviewValueJson[];
}

/** Parse a positive-integer id from a value, or `null` when malformed. */
function toPositiveInt(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0) {
      return n;
    }
  }
  return null;
}

/**
 * Normalise one entry from the request body into a {@link ReviewValueJson}.
 * Returns `null` when the entry is not a well-formed value object so the whole
 * request can be rejected with `VALIDATION_FAILED`.
 */
function toReviewValue(raw: unknown): ReviewValueJson | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  const taskFieldId = toPositiveInt(obj['taskFieldId']);
  if (taskFieldId === null) {
    return null;
  }
  const name =
    typeof obj['name'] === 'string' && obj['name'].length > 0 ? obj['name'] : null;
  // The value is entered by the user; coerce nullish to an empty string so an
  // omitted optional field still round-trips cleanly on the fallback path.
  const rawValue = obj['value'];
  const value =
    rawValue == null
      ? ''
      : typeof rawValue === 'string'
        ? rawValue
        : String(rawValue);
  return { taskFieldId, name, value };
}

/**
 * Parse and validate the `{ taskVersionId, values }` body. Throws
 * `VALIDATION_FAILED` when the shape is wrong so a malformed request is a clean
 * 400 rather than reaching the model.
 */
export function parseReviewSummaryBody(body: unknown): ReviewSummaryRequest {
  if (typeof body !== 'object' || body === null) {
    throw errors.validationFailed('A JSON body is required.', { field: 'body' });
  }
  const obj = body as Record<string, unknown>;

  const taskVersionId = toPositiveInt(obj['taskVersionId']);
  if (taskVersionId === null) {
    throw errors.validationFailed('A valid taskVersionId is required.', {
      field: 'taskVersionId',
    });
  }

  const rawValues = obj['values'];
  if (!Array.isArray(rawValues)) {
    throw errors.validationFailed('values must be an array.', { field: 'values' });
  }
  const values: ReviewValueJson[] = [];
  for (const entry of rawValues) {
    const value = toReviewValue(entry);
    if (value === null) {
      throw errors.validationFailed('Each value must have a valid taskFieldId.', {
        field: 'values',
      });
    }
    values.push(value);
  }

  return { taskVersionId, values };
}

/**
 * Build the plain-text prompt handed to the model from the entered values. Kept
 * simple and deterministic: one labelled line per entered value. Fields left
 * blank are omitted so the model summarises only what was actually provided.
 */
export function buildSummaryPrompt(request: ReviewSummaryRequest): string {
  const lines = request.values
    .filter((v) => v.value.trim().length > 0)
    .map((v) => `- ${v.name ?? `Field ${v.taskFieldId}`}: ${v.value}`);
  const body = lines.length > 0 ? lines.join('\n') : '(no details entered)';
  return [
    'Summarise the following helpdesk request in two or three concise sentences',
    'for a support team member. Do not invent details.',
    '',
    body,
  ].join('\n');
}

/**
 * `POST /review/summary` — generate the Step 3 summary via Ollama, falling back
 * to the echoed entered values on any failure (R2.11–2.12). The client is
 * injected for testability; production wiring uses {@link HttpOllamaClient}.
 */
export function createReviewSummaryHandler(client: OllamaClient): RequestHandler {
  return (req, res, next) => {
    void (async () => {
      const request = parseReviewSummaryBody(req.body);

      try {
        const summary = await client.generateSummary({
          taskVersionId: request.taskVersionId,
          prompt: buildSummaryPrompt(request),
        });
        const ok: ReviewSummaryAvailableJson = {
          available: true,
          taskVersionId: request.taskVersionId,
          summary,
        };
        res.status(200).json(ok);
      } catch {
        // Any error/timeout from the model → graceful fallback (R2.12). The
        // request still succeeds (HTTP 200) so the frontend can display the
        // entered values and allow submission; nothing is persisted.
        const fallback: ReviewSummaryFallbackJson = {
          available: false,
          taskVersionId: request.taskVersionId,
          values: request.values,
        };
        res.status(200).json(fallback);
      }
    })().catch(next);
  };
}

/** Register the review routes on a router (mounted at `/api`). */
export function registerReviewRoutes(router: Router, client: OllamaClient): Router {
  router.post('/review/summary', createReviewSummaryHandler(client));
  return router;
}

/** A standalone review router (used by tests and for isolated wiring). */
export function createReviewRouter(client: OllamaClient): Router {
  return registerReviewRoutes(Router(), client);
}

/** Production review router, wired to the HTTP-backed Ollama client. */
export const reviewRouter: Router = createReviewRouter(new HttpOllamaClient());
