import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Queryable } from '../db/query.js';
import {
  resolveAuditDisplays,
  type AuditEntryView,
} from './requests-detail.store.js';

/**
 * Tests for resolveAuditDisplays — id-bearing audit values are shown as human
 * labels (person names, team titles, task-version labels), null assignment as
 * "Unassigned", and non-id fields pass through unchanged. A fake Queryable
 * answers the batched label reads so no database is needed.
 */

function fakeDb(): Queryable {
  return {
    query: async (text: string) => {
      if (text.includes('FROM app_user')) {
        return {
          rows: [
            { id: 2, name: 'Bailey Adams' },
            { id: 7, name: 'Casey Adams' },
          ],
          rowCount: 2,
        } as never;
      }
      if (text.includes('FROM team')) {
        return { rows: [{ id: 4, title: 'Infrastructure & Servers' }], rowCount: 1 } as never;
      }
      if (text.includes('FROM task_version')) {
        return { rows: [{ id: 11, label: 'Create Server (v1)' }], rowCount: 1 } as never;
      }
      return { rows: [], rowCount: 0 } as never;
    },
  } as unknown as Queryable;
}

function entry(overrides: Partial<AuditEntryView>): AuditEntryView {
  return {
    id: 1,
    entityType: 'request',
    entityId: 100,
    fieldName: 'status',
    oldValue: null,
    newValue: null,
    oldDisplay: null,
    newDisplay: null,
    changedById: 1,
    changedByName: 'Someone',
    changedAt: '2026-02-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('resolveAuditDisplays', () => {
  it('resolves raised_by_id / team_id / task_version_id to labels', async () => {
    const out = await resolveAuditDisplays(
      [
        entry({ id: 1, fieldName: 'raised_by_id', oldValue: null, newValue: '2' }),
        entry({ id: 2, fieldName: 'team_id', oldValue: null, newValue: '4' }),
        entry({ id: 3, fieldName: 'task_version_id', oldValue: null, newValue: '11' }),
      ],
      fakeDb(),
    );
    assert.equal(out[0].newDisplay, 'Bailey Adams');
    assert.equal(out[1].newDisplay, 'Infrastructure & Servers');
    assert.equal(out[2].newDisplay, 'Create Server (v1)');
  });

  it('shows an assignment old/new: Unassigned -> name', async () => {
    const out = await resolveAuditDisplays(
      [entry({ fieldName: 'assigned_member_id', oldValue: null, newValue: '7' })],
      fakeDb(),
    );
    assert.equal(out[0].oldDisplay, 'Unassigned');
    assert.equal(out[0].newDisplay, 'Casey Adams');
  });

  it('passes non-id fields through unchanged', async () => {
    const out = await resolveAuditDisplays(
      [entry({ fieldName: 'status', oldValue: 'NEW', newValue: 'TRIAGE' })],
      fakeDb(),
    );
    assert.equal(out[0].oldDisplay, 'NEW');
    assert.equal(out[0].newDisplay, 'TRIAGE');
  });

  it('falls back to the raw id when it does not resolve', async () => {
    const out = await resolveAuditDisplays(
      [entry({ fieldName: 'raised_by_id', oldValue: null, newValue: '999' })],
      fakeDb(),
    );
    assert.equal(out[0].newDisplay, '999');
  });
});
