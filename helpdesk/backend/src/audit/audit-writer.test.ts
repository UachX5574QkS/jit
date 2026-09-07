import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Queryable } from '../db/query.js';
import {
  AuditWriter,
  diffFields,
  normaliseValue,
  type AuditContext,
} from './audit-writer.js';

/** A recorded call to a fake queryable: the SQL text and its bound params. */
interface RecordedCall {
  readonly text: string;
  readonly params: readonly unknown[];
}

/**
 * A fake {@link Queryable} that records every statement without touching a
 * database (matching the DB-free, injectable style of the identity tests). It
 * only needs `query`; the writer uses nothing else.
 */
function recordingDb(): { db: Queryable; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const db = {
    query: async (text: string, params?: unknown[]) => {
      calls.push({ text, params: params ?? [] });
      return { rows: [], rowCount: 0 } as never;
    },
  } as unknown as Queryable;
  return { db, calls };
}

const ctx: AuditContext = {
  entityType: 'request',
  entityId: 42,
  changedById: 7,
};

describe('normaliseValue', () => {
  it('maps null and undefined to SQL NULL', () => {
    assert.equal(normaliseValue(null), null);
    assert.equal(normaliseValue(undefined), null);
  });

  it('stringifies primitives (number, boolean, string) as text', () => {
    assert.equal(normaliseValue(1), '1');
    assert.equal(normaliseValue(0), '0');
    assert.equal(normaliseValue(true), 'true');
    assert.equal(normaliseValue(false), 'false');
    assert.equal(normaliseValue('hello'), 'hello');
    assert.equal(normaliseValue(''), '');
  });

  it('renders Date as ISO-8601 (matching the timestamptz API contract)', () => {
    const d = new Date('2026-01-02T03:04:05.000Z');
    assert.equal(normaliseValue(d), '2026-01-02T03:04:05.000Z');
  });
});

describe('diffFields', () => {
  it('emits a change only for fields whose value actually changed', () => {
    const changes = diffFields(
      { status: 'NEW', title: 'A', priority: 3 },
      { status: 'TRIAGE', title: 'A', priority: 3 },
    );
    assert.deepEqual(changes, [
      { field: 'status', oldValue: 'NEW', newValue: 'TRIAGE' },
    ]);
  });

  it('returns an empty list when nothing changed', () => {
    assert.deepEqual(diffFields({ a: 1, b: 'x' }, { a: 1, b: 'x' }), []);
  });

  it('captures a first-time set (field only in after) as old NULL → new value', () => {
    const changes = diffFields({}, { assignee: 9 });
    assert.deepEqual(changes, [
      { field: 'assignee', oldValue: undefined, newValue: 9 },
    ]);
  });

  it('captures a cleared field (field only in before) as value → NULL', () => {
    const changes = diffFields({ assignee: 9 }, {});
    assert.deepEqual(changes, [
      { field: 'assignee', oldValue: 9, newValue: undefined },
    ]);
  });

  it('treats null as a real audited "no value" distinct from a set value', () => {
    const changes = diffFields({ note: 'x' }, { note: null });
    assert.deepEqual(changes, [
      { field: 'note', oldValue: 'x', newValue: null },
    ]);
  });

  it('compares on normalised text: Date equals its ISO string, no spurious diff', () => {
    const iso = '2026-01-02T03:04:05.000Z';
    assert.deepEqual(diffFields({ due: new Date(iso) }, { due: iso }), []);
  });

  it('compares on normalised text: number 1 does not differ from string "1"', () => {
    assert.deepEqual(diffFields({ n: 1 }, { n: '1' }), []);
  });
});

describe('AuditWriter.record', () => {
  it('writes exactly one parameterised row per changed column (R17.1, R17.2)', async () => {
    const { db, calls } = recordingDb();
    const writer = new AuditWriter();

    const written = await writer.record(
      ctx,
      [
        { field: 'status', oldValue: 'NEW', newValue: 'TRIAGE' },
        { field: 'assignee', oldValue: null, newValue: 9 },
      ],
      db,
    );

    assert.equal(written, 2);
    assert.equal(calls.length, 2);

    // Every statement is an INSERT into audit_entry using positional
    // placeholders only — no interpolated values anywhere in the text.
    for (const call of calls) {
      assert.match(call.text, /INSERT INTO audit_entry/);
      assert.doesNotMatch(call.text, /NEW|TRIAGE|assignee/);
    }

    // First row: status NEW -> TRIAGE, captured at column level.
    assert.deepEqual(calls[0]?.params, [
      'request',
      42,
      'status',
      'NEW',
      'TRIAGE',
      7,
    ]);
    // Second row: assignee null -> 9 (first-time set records NULL old value).
    assert.deepEqual(calls[1]?.params, [
      'request',
      42,
      'assignee',
      null,
      '9',
      7,
    ]);
  });

  it('is a no-op for an empty change set (no rows, no statements)', async () => {
    const { db, calls } = recordingDb();
    const writer = new AuditWriter();
    const written = await writer.record(ctx, [], db);
    assert.equal(written, 0);
    assert.equal(calls.length, 0);
  });

  it('binds a supplied changedAt as a parameter (never interpolated)', async () => {
    const { db, calls } = recordingDb();
    const writer = new AuditWriter();
    const changedAt = new Date('2026-03-04T05:06:07.000Z');

    await writer.record(
      { ...ctx, changedAt },
      [{ field: 'status', oldValue: 'NEW', newValue: 'TRIAGE' }],
      db,
    );

    assert.equal(calls.length, 1);
    // The event time is the 7th bound parameter, and the column appears in the
    // statement text as a placeholder.
    assert.match(calls[0]?.text ?? '', /changed_at/);
    assert.equal(calls[0]?.params[6], changedAt);
    assert.doesNotMatch(calls[0]?.text ?? '', /2026-03-04/);
  });

  it('runs on the SAME queryable it is given — never opens its own', async () => {
    // Two independent fakes stand in for "the transaction client" and "the
    // pool". The writer must use the per-call db (the tx client), proving it
    // participates in the caller's transaction rather than a connection of its
    // own (R17.1: same transaction as the mutation).
    const tx = recordingDb();
    const other = recordingDb();
    // Construct the writer with a DIFFERENT default db to be sure the per-call
    // argument wins.
    const writer = new AuditWriter(other.db);

    await writer.record(
      ctx,
      [{ field: 'status', oldValue: 'NEW', newValue: 'TRIAGE' }],
      tx.db,
    );

    assert.equal(tx.calls.length, 1, 'wrote through the transaction client');
    assert.equal(other.calls.length, 0, 'did not touch any other connection');

    // The writer issues no BEGIN/COMMIT/ROLLBACK of its own — transaction
    // boundaries belong to the caller (withTransaction).
    for (const call of tx.calls) {
      assert.doesNotMatch(call.text, /\b(BEGIN|COMMIT|ROLLBACK)\b/i);
    }
  });

  it('falls back to the writer default db when no per-call db is passed', async () => {
    const def = recordingDb();
    const writer = new AuditWriter(def.db);
    await writer.record(ctx, [
      { field: 'title', oldValue: 'A', newValue: 'B' },
    ]);
    assert.equal(def.calls.length, 1);
  });
});

describe('AuditWriter.recordChanges', () => {
  it('diffs before→after and writes only the changed columns', async () => {
    const { db, calls } = recordingDb();
    const writer = new AuditWriter();

    const written = await writer.recordChanges(
      ctx,
      { status: 'NEW', title: 'Same', assignee: null },
      { status: 'TRIAGE', title: 'Same', assignee: 9 },
      db,
    );

    assert.equal(written, 2, 'only status and assignee changed');
    assert.equal(calls.length, 2);
    const fields = calls.map((c) => c.params[2]).sort();
    assert.deepEqual(fields, ['assignee', 'status']);
  });

  it('writes nothing when the snapshots are identical', async () => {
    const { db, calls } = recordingDb();
    const writer = new AuditWriter();
    const written = await writer.recordChanges(
      ctx,
      { status: 'NEW' },
      { status: 'NEW' },
      db,
    );
    assert.equal(written, 0);
    assert.equal(calls.length, 0);
  });
});
