import type { Queryable, SqlParam } from '../db/query.js';
import { query } from '../db/query.js';
import { pool } from '../db/pool.js';

/**
 * Column-level audit writer (design: "Audit — column-level audit rows written
 * in the same transaction as any mutation", R17.1, R17.2).
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 * Given an audited entity (`entityType` + `entityId`), the acting user, and a
 * set of old→new field changes, it computes the per-column diff (only the
 * fields whose value actually changed) and inserts ONE `audit_entry` row per
 * changed column: who changed it, the field name, its previous value and its
 * new value (R17.1). Auditing at the field level is the whole point — a single
 * mutation touching three fields yields three rows (R17.2).
 *
 * ── Same-transaction guarantee ───────────────────────────────────────────────
 * The writer NEVER opens its own connection, `BEGIN`s, or `COMMIT`s. It issues
 * its INSERTs through whatever {@link Queryable} the caller supplies — which, in
 * a real mutation, is the transaction client from `withTransaction`. That makes
 * the audit rows part of the SAME transaction as the mutation: if the mutation
 * rolls back, so do its audit rows, and vice versa. Callers that pass no `db`
 * fall back to the pool (autocommit) — acceptable only for a standalone write
 * with nothing else to coordinate.
 *
 *   await withTransaction(async (tx) => {
 *     await query('UPDATE request SET status = $1 WHERE id = $2', [next, id], tx);
 *     await auditWriter.record(
 *       { entityType: 'request', entityId: id, changedById: user.id },
 *       diffFields({ status: prev }, { status: next }),
 *       tx, // <-- same transaction as the UPDATE above
 *     );
 *   });
 *
 * ── SQL safety ───────────────────────────────────────────────────────────────
 * Every value travels as a bound parameter (`$1`, `$2`, …) via the
 * parameterised data-access layer; nothing is interpolated into SQL text.
 */

/** Identifies the audited row and who is changing it. */
export interface AuditContext {
  /** The kind of audited entity, e.g. `'request'`, `'request_note'` (R17.1). */
  readonly entityType: string;
  /** The id of the audited row within its entity type (R17.1). */
  readonly entityId: number;
  /** The `app_user.id` making the change (R17.1). */
  readonly changedById: number;
  /**
   * Optional authoritative event time for the change. When omitted, the
   * database `now()` default is used. Supply this to keep every row from one
   * mutation on an identical timestamp.
   */
  readonly changedAt?: Date;
}

/**
 * A single column-level change. `oldValue`/`newValue` are the raw values before
 * and after; they are normalised to the `text` shape the `audit_entry` columns
 * store (see {@link normaliseValue}). Either side may be `null` (a value set for
 * the first time, or cleared).
 */
export interface FieldChange {
  readonly field: string;
  readonly oldValue: AuditableValue;
  readonly newValue: AuditableValue;
}

/**
 * A value that can appear in an audited field. `undefined` means "field not
 * present in this snapshot" and is treated as absent by {@link diffFields};
 * `null` is a real, audited "no value".
 */
export type AuditableValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined;

/** A snapshot of an entity's audited fields keyed by column name. */
export type FieldSnapshot = Readonly<Record<string, AuditableValue>>;

/**
 * Normalise an audited value to the `text` representation stored in
 * `audit_entry.old_value` / `new_value`. `null`/`undefined` map to SQL NULL;
 * `Date` uses ISO-8601 (consistent with the API's `timestamptz` contract);
 * everything else is stringified. Kept private-ish but exported for reuse/tests.
 */
export function normaliseValue(value: AuditableValue): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

/**
 * Compute the per-column diff between a `before` and `after` snapshot, emitting
 * a {@link FieldChange} ONLY for fields whose normalised value actually changed
 * (R17.2 — column-level; no row for an unchanged field). Comparison is done on
 * the normalised (text) form so that, e.g., a `Date` and its ISO string compare
 * equal and a numeric `1` does not spuriously differ from a string `'1'`.
 *
 * The union of both snapshots' keys is considered, so a field present only in
 * `after` (first-time set: old→NULL) or only in `before` (cleared: →NULL) is
 * captured. A field explicitly `undefined` on a side is treated as absent.
 *
 * Pure and side-effect free — the unit tests exercise it without a database.
 */
export function diffFields(
  before: FieldSnapshot,
  after: FieldSnapshot,
): FieldChange[] {
  const fields = new Set<string>([
    ...Object.keys(before),
    ...Object.keys(after),
  ]);
  const changes: FieldChange[] = [];
  for (const field of fields) {
    const oldValue = before[field];
    const newValue = after[field];
    if (normaliseValue(oldValue) === normaliseValue(newValue)) {
      continue;
    }
    changes.push({ field, oldValue, newValue });
  }
  return changes;
}

/**
 * Writes column-level audit rows. Stateless aside from its (optional) default
 * queryable; the transaction seam is always the per-call `db` argument.
 */
export class AuditWriter {
  /**
   * @param db Default queryable used when a call omits one. Defaults to the
   *   pool (autocommit). Real mutations MUST pass a transaction client per call
   *   so the audit shares the mutation's transaction.
   */
  constructor(private readonly db: Queryable = pool) {}

  /**
   * Insert one `audit_entry` row per change in `changes`.
   *
   * @param ctx     entity type/id, acting user, optional event time.
   * @param changes the per-column changes to record (typically from
   *                {@link diffFields}); an empty list is a no-op.
   * @param db      the queryable to run on. Pass the mutation's transaction
   *                client to keep the audit in the SAME transaction (R17.1).
   *                Defaults to the writer's `db`.
   * @returns the number of rows written (one per changed column).
   */
  async record(
    ctx: AuditContext,
    changes: readonly FieldChange[],
    db: Queryable = this.db,
  ): Promise<number> {
    if (changes.length === 0) {
      return 0;
    }
    for (const change of changes) {
      const params: SqlParam[] = [
        ctx.entityType,
        ctx.entityId,
        change.field,
        normaliseValue(change.oldValue),
        normaliseValue(change.newValue),
        ctx.changedById,
      ];
      // changed_at: bind the caller's event time when supplied, otherwise let
      // the column DEFAULT now() stand. Two shapes, both fully parameterised.
      if (ctx.changedAt !== undefined) {
        await query(
          `INSERT INTO audit_entry
             (entity_type, entity_id, field_name, old_value, new_value,
              changed_by_id, changed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [...params, ctx.changedAt],
          db,
        );
      } else {
        await query(
          `INSERT INTO audit_entry
             (entity_type, entity_id, field_name, old_value, new_value,
              changed_by_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          params,
          db,
        );
      }
    }
    return changes.length;
  }

  /**
   * Convenience: diff `before`→`after` and record the changed columns in one
   * call. Returns the number of rows written (0 when nothing changed), so a
   * caller can tell whether the entity actually changed.
   */
  async recordChanges(
    ctx: AuditContext,
    before: FieldSnapshot,
    after: FieldSnapshot,
    db: Queryable = this.db,
  ): Promise<number> {
    return this.record(ctx, diffFields(before, after), db);
  }
}
