import { one, withTransaction, type Queryable } from '../db/query.js';
import { AuditWriter } from '../audit/index.js';

/**
 * Data-access layer for the UNIFIED add-note operation (design: "Requests (user
 * side)" — `POST /api/requests/{id}/notes`, R5.3; and "Support side" — the same
 * `POST /api/requests/{id}/notes`, internal or external, R7.3–7.6).
 *
 * ── Why one endpoint / one store ─────────────────────────────────────────────
 * The design lists a SINGLE `POST /api/requests/{id}/notes` for BOTH the raiser
 * (who may add only external notes, R5.3) and support (who may add internal OR
 * external notes, R7.3/R7.4). Rather than two colliding routes, this store owns
 * the one operation and branches on the caller's relationship to the request:
 *
 *   • A SUPPORT MEMBER of the request's team may add EITHER an external note
 *     (`is_internal = false`, visible to the raiser on the Requests screen —
 *     R7.3) OR an internal note (`is_internal = true`, visible only to support
 *     on the Support screen, never to the raiser — R7.4). The `isInternal` flag
 *     in the request body is honoured, defaulting to `false`.
 *   • The RAISER (who is not a support member of the team) may add ONLY an
 *     external note; `isInternal` is FORCED to `false` regardless of the body
 *     (R5.3). Support notes are the support member's privilege.
 *   • Anyone else → {@link RequestForbiddenError} (403 FORBIDDEN).
 *
 * ── "Updated"-trigger behaviour (R7.5, R7.6) ─────────────────────────────────
 * The note is authored by the current user and column-level audited in the SAME
 * transaction as the insert (R17). Whether it bumps `request.updated_at` — the
 * denormalised signal that would fire the raiser's "Updated" indicator — depends
 * on internal-vs-external:
 *
 *   • EXTERNAL note → a NON-internal change: bump `updated_at` so the raiser's
 *     "Updated" indicator fires (R7.6), matching every other non-internal
 *     change (field/Jira/status updates).
 *   • INTERNAL note → must NOT trigger the raiser's "Updated" indicator, so
 *     `updated_at` is deliberately LEFT UNCHANGED (R7.5). The list-store
 *     "Updated" computations (tasks 6.8/7.1) already exclude internal-note audit
 *     entries, so the internal note never flags the raiser's view either way;
 *     it still surfaces to support on the Support detail screen + audit trail,
 *     which is where support "sees" the update (R7.5, R17.4).
 *
 * ── Injectability + SQL safety ───────────────────────────────────────────────
 * The route handler depends on the narrow {@link RequestNotesStore} interface,
 * never on `pg` directly, so it unit-tests with an in-memory fake — matching the
 * injectable style of the create/detail/user-/support-mutations stores. The
 * production {@link DbRequestNotesStore} is the only place that talks to
 * Postgres, and only through the parameterised data-access layer (`db/query.ts`):
 * every value travels as a bound placeholder, nothing is interpolated into SQL.
 */

// ── Shared error types (mapped to the uniform envelope by the route layer) ─────

/** Raised when the request id does not exist. Mapped to 404 NOT_FOUND. */
export class RequestNotFoundError extends Error {
  constructor(readonly requestId: number) {
    super(`Request ${requestId} not found`);
    this.name = 'RequestNotFoundError';
  }
}

/**
 * Raised when the current user may not add a note to the request (neither the
 * raiser nor a support member of the request's team). Mapped to 403 FORBIDDEN.
 */
export class RequestForbiddenError extends Error {
  constructor(readonly requestId: number, message?: string) {
    super(message ?? `Not permitted to add a note to request ${requestId}`);
    this.name = 'RequestForbiddenError';
  }
}

// ── Public input / output shapes (camelCase, ISO dates) ────────────────────────

/** The validated add-note input (R5.3, R7.3–7.4). */
export interface AddNoteInput {
  /** The note body (already trimmed non-empty by the route layer). */
  readonly body: string;
  /**
   * Whether the note is internal (support-only). Honoured for a support member
   * of the request's team; FORCED to `false` for the raiser (R5.3). Defaults to
   * `false` when the caller omits it.
   */
  readonly isInternal: boolean;
}

/** The actor context: their id and the teams they are a member of (R7.3–7.4). */
export interface NoteActor {
  /** The current user's `app_user.id`. */
  readonly userId: number;
  /** The current user's team memberships (support-member test). */
  readonly teamsMemberOf: ReadonlyArray<number>;
}

/** A newly created note (camelCase, ISO dates). */
export interface CreatedNote {
  readonly id: number;
  readonly requestId: number;
  readonly authorId: number;
  readonly isInternal: boolean;
  readonly body: string;
  readonly createdAt: string;
}

/** The narrow contract the route handler depends on. */
export interface RequestNotesStore {
  /**
   * Add a note to a request (R5.3, R7.3–7.6). A support member of the request's
   * team may add an internal OR external note (`isInternal` honoured); the
   * raiser may add only an external note (`isInternal` forced to `false`); any
   * other caller → {@link RequestForbiddenError}. The note is authored by the
   * actor and audited in the same transaction (R17). `updated_at` is bumped for
   * an EXTERNAL note (fires the raiser's "Updated" indicator, R7.6) and left
   * unchanged for an INTERNAL note (R7.5). Throws {@link RequestNotFoundError}
   * for an unknown request.
   */
  addNote(
    requestId: number,
    input: AddNoteInput,
    actor: NoteActor,
  ): Promise<CreatedNote>;
}

// ── DB row shapes ─────────────────────────────────────────────────────────────

interface RequestHeaderDbRow {
  id: string | number;
  raised_by_id: string | number;
  team_id: string | number;
}

interface NoteDbRow {
  id: string | number;
  request_id: string | number;
  author_id: string | number;
  is_internal: boolean;
  body: string;
  created_at: Date | string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** ISO-8601 UTC string for a `timestamptz` value (design: dates as ISO-8601). */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * A runner that executes `fn` inside a single database transaction. Production
 * uses {@link withTransaction}; tests inject a pass-through backed by a fake
 * {@link Queryable}. The note insert shares one transaction with its audit row.
 */
export type TransactionRunner = <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T>;

const defaultTransactionRunner: TransactionRunner = (fn) =>
  withTransaction((client) => fn(client));

/** The SQL selecting just the fields the authorisation gate needs. */
const HEADER_SQL = `SELECT r.id            AS id,
        r.raised_by_id  AS raised_by_id,
        r.team_id       AS team_id
   FROM request r
  WHERE r.id = $1`;

/**
 * Postgres-backed {@link RequestNotesStore}. All SQL is parameterised; the note
 * insert, its audit row, and any `updated_at` bump share one transaction.
 */
export class DbRequestNotesStore implements RequestNotesStore {
  constructor(
    private readonly audit: AuditWriter = new AuditWriter(),
    private readonly runTransaction: TransactionRunner = defaultTransactionRunner,
  ) {}

  async addNote(
    requestId: number,
    input: AddNoteInput,
    actor: NoteActor,
  ): Promise<CreatedNote> {
    return this.runTransaction(async (tx) => {
      const header = await one<RequestHeaderDbRow>(HEADER_SQL, [requestId], tx);
      if (!header) {
        throw new RequestNotFoundError(requestId);
      }

      const teamId = Number(header.team_id);
      const raisedById = Number(header.raised_by_id);
      const isSupportMember = actor.teamsMemberOf.includes(teamId);
      const isRaiser = raisedById === actor.userId;

      // Only a support member of the request's team or the raiser may add a
      // note (R5.3, R7.3–7.4). A support member's `isInternal` is honoured; the
      // raiser (who is not support) is forced to an external note; anyone else
      // is FORBIDDEN.
      if (!isSupportMember && !isRaiser) {
        throw new RequestForbiddenError(
          requestId,
          'Only the raiser or a support member of the request team may add a note.',
        );
      }
      const isInternal = isSupportMember ? input.isInternal : false;

      // Insert the note authored by the current user.
      const inserted = await one<NoteDbRow>(
        `INSERT INTO request_note (request_id, author_id, is_internal, body)
         VALUES ($1, $2, $3, $4)
         RETURNING id, request_id, author_id, is_internal, body, created_at`,
        [requestId, actor.userId, isInternal, input.body],
        tx,
      );
      if (!inserted) {
        throw new Error('INSERT ... RETURNING produced no row');
      }

      // Audit the note creation (first-set: old → NULL), same transaction (R17).
      await this.audit.recordChanges(
        {
          entityType: 'request_note',
          entityId: Number(inserted.id),
          changedById: actor.userId,
        },
        {},
        { is_internal: isInternal, body: input.body },
        tx,
      );

      // Bump `updated_at` ONLY for an EXTERNAL note: a non-internal change must
      // fire the raiser's "Updated" indicator (R7.6). An INTERNAL note must NOT
      // trigger it, so `updated_at` is deliberately left unchanged (R7.5) — the
      // internal note still surfaces to support via the Support detail/audit.
      if (!isInternal) {
        await one<{ id: string | number }>(
          `UPDATE request SET updated_at = now() WHERE id = $1 RETURNING id`,
          [requestId],
          tx,
        );
      }

      return {
        id: Number(inserted.id),
        requestId: Number(inserted.request_id),
        authorId: Number(inserted.author_id),
        isInternal: inserted.is_internal,
        body: inserted.body,
        createdAt: toIso(inserted.created_at),
      };
    });
  }
}
