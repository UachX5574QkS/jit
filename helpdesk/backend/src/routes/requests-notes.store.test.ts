import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Queryable } from '../db/query.js';
import {
  DbRequestNotesStore,
  RequestForbiddenError,
  RequestNotFoundError,
  type NoteActor,
  type TransactionRunner,
} from './requests-notes.store.js';

/**
 * Tests for the Postgres-backed UNIFIED add-note store (design: single
 * `POST /api/requests/{id}/notes` for the raiser (external only, R5.3) and
 * support (internal or external, R7.3–7.6)). A fake {@link Queryable} answers
 * the store's SELECT/INSERT/UPDATE statements by matching SQL fragments and
 * records every call; the transaction runner is a pass-through that hands that
 * fake to the store — so the raiser/support gate, the internal-vs-external
 * decision, same-transaction audit, and the "Updated"-trigger (`updated_at`
 * bump only for an external note) are exercised WITHOUT a live database,
 * matching the user-/support-mutations store test style.
 */

interface RecordedCall {
  readonly text: string;
  readonly params: readonly unknown[];
}

/** The trimmed request header row the store's authorisation query expects. */
function headerRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 555,
    raised_by_id: 100,
    team_id: 7,
    ...overrides,
  };
}

/** A `request_note` RETURNING row for a freshly inserted note. */
function noteDbRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 77,
    request_id: 555,
    author_id: 100,
    is_internal: false,
    body: 'Please hurry',
    created_at: new Date('2026-02-02T09:00:00.000Z'),
    ...overrides,
  };
}

/**
 * A fake queryable + pass-through transaction runner. `responder` returns the
 * rows for a given statement; `calls` records everything for assertions.
 */
function fakeDb(responder: (text: string, params: readonly unknown[]) => unknown[]): {
  db: Queryable;
  runTransaction: TransactionRunner;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const db = {
    query: async (text: string, params?: unknown[]) => {
      const bound = params ?? [];
      calls.push({ text, params: bound });
      return { rows: responder(text, bound), rowCount: 0 } as never;
    },
  } as unknown as Queryable;
  const runTransaction: TransactionRunner = (fn) => fn(db);
  return { db, runTransaction, calls };
}

/** A store wired to a fake db (the AuditWriter writes on the same fake tx). */
function makeStore(responder: (text: string, params: readonly unknown[]) => unknown[]) {
  const fake = fakeDb(responder);
  const store = new DbRequestNotesStore(undefined, fake.runTransaction);
  return { store, ...fake };
}

function callWith(calls: RecordedCall[], fragment: string): RecordedCall | undefined {
  return calls.find((c) => c.text.includes(fragment));
}

function callsWith(calls: RecordedCall[], fragment: string): RecordedCall[] {
  return calls.filter((c) => c.text.includes(fragment));
}

/** The raiser of request 555 (id 100), not a member of team 7. */
const raiser: NoteActor = { userId: 100, teamsMemberOf: [] };
/** A support member of the request's team (team 7), not the raiser. */
const supporter: NoteActor = { userId: 200, teamsMemberOf: [7] };
/** Neither the raiser nor a member of the request's team. */
const outsider: NoteActor = { userId: 300, teamsMemberOf: [8, 9] };

// ── Support: external note (R7.3) ─────────────────────────────────────────────

describe('DbRequestNotesStore.addNote — support external note (R7.3)', () => {
  it('inserts is_internal=false, audits it, and bumps updated_at (fires "Updated")', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow()];
      if (text.includes('INSERT INTO request_note')) return [noteDbRow({ author_id: 200 })];
      if (text.includes('UPDATE request')) return [{ id: 555 }];
      if (text.includes('INSERT INTO audit_entry')) return [];
      return [];
    });

    const note = await store.addNote(555, { body: 'visible to raiser', isInternal: false }, supporter);

    assert.equal(note.isInternal, false);
    assert.equal(note.authorId, 200);
    // Inserted with is_internal bound as false, authored by the support member.
    const insert = callWith(calls, 'INSERT INTO request_note');
    assert.ok(insert);
    assert.deepEqual(insert.params, [555, 200, false, 'visible to raiser']);
    // Audited on the same tx.
    assert.ok(callWith(calls, 'INSERT INTO audit_entry'));
    // External note → updated_at bumped so the raiser's "Updated" fires (R7.6).
    assert.ok(
      callsWith(calls, 'UPDATE request').some((c) => c.text.includes('updated_at = now()')),
    );
  });
});

// ── Support: internal note (R7.4, R7.5) ───────────────────────────────────────

describe('DbRequestNotesStore.addNote — support internal note (R7.4, R7.5)', () => {
  it('inserts is_internal=true, audits it, and does NOT bump updated_at', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow()];
      if (text.includes('INSERT INTO request_note')) {
        return [noteDbRow({ author_id: 200, is_internal: true, body: 'support only' })];
      }
      if (text.includes('INSERT INTO audit_entry')) return [];
      return [];
    });

    const note = await store.addNote(555, { body: 'support only', isInternal: true }, supporter);

    assert.equal(note.isInternal, true);
    // Inserted with is_internal bound as true.
    const insert = callWith(calls, 'INSERT INTO request_note');
    assert.ok(insert);
    assert.deepEqual(insert.params, [555, 200, true, 'support only']);
    // Audited on the same tx (still recorded in the audit trail, R17.4).
    assert.ok(callWith(calls, 'INSERT INTO audit_entry'));
    // Internal note → updated_at must NOT be bumped, so the raiser's "Updated"
    // indicator never fires for an internal-only change (R7.5).
    assert.equal(
      callsWith(calls, 'UPDATE request').find((c) => c.text.includes('updated_at = now()')),
      undefined,
    );
  });
});

// ── Raiser: forced external (R5.3) ────────────────────────────────────────────

describe('DbRequestNotesStore.addNote — raiser note is forced external (R5.3)', () => {
  it('ignores isInternal=true from the raiser and inserts is_internal=false, bumping updated_at', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow()];
      if (text.includes('INSERT INTO request_note')) return [noteDbRow()];
      if (text.includes('UPDATE request')) return [{ id: 555 }];
      if (text.includes('INSERT INTO audit_entry')) return [];
      return [];
    });

    // The raiser is NOT a support member of team 7, so even isInternal=true is
    // forced to an external note.
    const note = await store.addNote(555, { body: 'Please hurry', isInternal: true }, raiser);

    assert.equal(note.isInternal, false);
    const insert = callWith(calls, 'INSERT INTO request_note');
    assert.ok(insert);
    assert.deepEqual(insert.params, [555, 100, false, 'Please hurry']);
    // External note → updated_at bumped (R7.6).
    assert.ok(
      callsWith(calls, 'UPDATE request').some((c) => c.text.includes('updated_at = now()')),
    );
  });
});

// ── Authorisation & not-found ─────────────────────────────────────────────────

describe('DbRequestNotesStore.addNote — authorisation & not-found', () => {
  it('rejects a caller who is neither the raiser nor a support member (FORBIDDEN)', async () => {
    const { store, calls } = makeStore((text) => {
      if (text.includes('FROM request r')) return [headerRow()];
      return [];
    });

    await assert.rejects(
      () => store.addNote(555, { body: 'nope', isInternal: false }, outsider),
      (e) => e instanceof RequestForbiddenError && e.requestId === 555,
    );
    // Bailed out before any write.
    assert.equal(callWith(calls, 'INSERT INTO request_note'), undefined);
    assert.equal(callWith(calls, 'INSERT INTO audit_entry'), undefined);
    assert.equal(callWith(calls, 'UPDATE request'), undefined);
  });

  it('throws RequestNotFoundError for an unknown request', async () => {
    const { store, calls } = makeStore(() => []);
    await assert.rejects(
      () => store.addNote(999, { body: 'hi', isInternal: false }, supporter),
      (e) => e instanceof RequestNotFoundError && e.requestId === 999,
    );
    assert.equal(callWith(calls, 'INSERT INTO request_note'), undefined);
  });
});

// ── Audit-in-transaction (R17) ─────────────────────────────────────────────────

describe('DbRequestNotesStore.addNote — audit in transaction (R17)', () => {
  it('runs the note insert and its audit on the SAME tx client', async () => {
    const seenOnTx: string[] = [];
    const { store } = makeStore((text) => {
      seenOnTx.push(text);
      if (text.includes('FROM request r')) return [headerRow()];
      if (text.includes('INSERT INTO request_note')) return [noteDbRow({ author_id: 200 })];
      if (text.includes('UPDATE request')) return [{ id: 555 }];
      if (text.includes('INSERT INTO audit_entry')) return [];
      return [];
    });

    await store.addNote(555, { body: 'x', isInternal: false }, supporter);

    // The insert and its audit both ran through the same recorded queryable, so
    // they share the mutation's transaction (R17): a failure would roll back all.
    assert.ok(seenOnTx.some((t) => t.includes('INSERT INTO request_note')));
    assert.ok(seenOnTx.some((t) => t.includes('INSERT INTO audit_entry')));
  });
});
