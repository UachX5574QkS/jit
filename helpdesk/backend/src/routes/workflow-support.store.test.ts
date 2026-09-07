import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Queryable } from '../db/query.js';
import {
  DbWorkflowSupportStore,
  TaskNotFoundError,
} from './workflow-support.store.js';

/**
 * Tests for the Postgres-backed workflow-support store (design: "Workflow
 * support", R2.3, R2.5–2.8, R3.5). A fake {@link Queryable} answers the store's
 * SELECT statements and records every call, so the open-teams filter, the
 * active-tasks filter, and the current-version field merge (incl. dropdown
 * option override resolution) are exercised WITHOUT a live database — matching
 * the fake-queryable style used by the team-admin/task-leader store tests.
 *
 * The fake keys its responses off a fragment of each SQL statement rather than
 * the exact text, so the tests assert behaviour (which statements ran, with
 * which bound params, and how rows are merged) rather than pinning to
 * whitespace.
 */

interface RecordedCall {
  readonly text: string;
  readonly params: readonly unknown[];
}

/** A fake queryable whose `responder` returns rows per statement fragment. */
function fakeDb(responder: (text: string, params: readonly unknown[]) => unknown[]): {
  db: Queryable;
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
  return { db, calls };
}

/** Find a recorded call whose SQL contains `fragment`. */
function callWith(calls: RecordedCall[], fragment: string): RecordedCall | undefined {
  return calls.find((c) => c.text.includes(fragment));
}

// ── listOpenTeams (R2.3, R13.4) ────────────────────────────────────────────────

describe('DbWorkflowSupportStore.listOpenTeams (R2.3, R13.4)', () => {
  it('selects only non-closed teams and maps them to the open-team view', async () => {
    const { db, calls } = fakeDb((text) => {
      if (text.includes('FROM team')) {
        return [
          { id: 3, title: 'Access', description: 'Access requests' },
          { id: 1, title: 'Payments', description: null },
        ];
      }
      return [];
    });
    const store = new DbWorkflowSupportStore(db);

    const teams = await store.listOpenTeams();

    assert.deepEqual(teams, [
      { id: 3, title: 'Access', description: 'Access requests' },
      { id: 1, title: 'Payments', description: null },
    ]);

    // The query filters on is_closed = false — closed teams are never offered.
    const select = callWith(calls, 'FROM team');
    assert.ok(select);
    assert.match(select.text, /is_closed\s*=\s*false/);
  });

  it('returns an empty list when no team is open', async () => {
    const { db } = fakeDb(() => []);
    const store = new DbWorkflowSupportStore(db);
    assert.deepEqual(await store.listOpenTeams(), []);
  });
});

// ── listActiveTasks (R2.3, R16.6) ──────────────────────────────────────────────

describe('DbWorkflowSupportStore.listActiveTasks (R2.3, R16.6)', () => {
  it('selects only non-retired tasks for the bound team id', async () => {
    const { db, calls } = fakeDb((text) => {
      if (text.includes('FROM task')) {
        return [
          { id: 10, team_id: 7, name: 'New Laptop' },
          { id: 11, team_id: 7, name: 'Reset Password' },
        ];
      }
      return [];
    });
    const store = new DbWorkflowSupportStore(db);

    const tasks = await store.listActiveTasks(7);

    assert.deepEqual(tasks, [
      { id: 10, teamId: 7, name: 'New Laptop' },
      { id: 11, teamId: 7, name: 'Reset Password' },
    ]);

    // The team id is bound (not interpolated) and the filter excludes retired.
    const select = callWith(calls, 'FROM task');
    assert.ok(select);
    assert.deepEqual(select.params, [7]);
    assert.match(select.text, /is_retired\s*=\s*false/);
    assert.match(select.text, /team_id\s*=\s*\$1/);
  });

  it('returns an empty list for an unknown/closed team (no task selectable)', async () => {
    const { db } = fakeDb(() => []);
    const store = new DbWorkflowSupportStore(db);
    assert.deepEqual(await store.listActiveTasks(999), []);
  });
});

// ── getCurrentVersion — field merge (R2.5–2.8, R3.5, R16.3, R16.5) ─────────────

/** A current-version header row as the DB would return it. */
function headerRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    task_id: 10,
    task_name: 'New Laptop',
    team_id: 7,
    version_id: 55,
    version_no: 2,
    support_notes: 'Check asset register first',
    ...overrides,
  };
}

describe('DbWorkflowSupportStore.getCurrentVersion (R2.5–2.8, R3.5, R16.5)', () => {
  it('joins to the current version and returns fields in field order with the header', async () => {
    const { db, calls } = fakeDb((text) => {
      if (text.includes('JOIN task_version')) {
        return [headerRow()];
      }
      if (text.includes('JOIN data_point')) {
        // Deliberately returned out of order; the SQL ORDER BY does the sorting
        // in production, but we assert the store threads rows through faithfully.
        return [
          {
            task_field_id: 100,
            data_point_id: 200,
            field_order: 0,
            is_mandatory: true,
            description_override: null,
            help_text_override: null,
            options_override: null,
            dp_name: 'Full Name',
            dp_data_type: 'TEXT',
            dp_description: 'The requester full name',
            dp_default_help_text: 'Enter your full name',
            dp_default_options: null,
            dp_regexp_pattern: null,
          },
        ];
      }
      return [];
    });
    const store = new DbWorkflowSupportStore(db);

    const version = await store.getCurrentVersion(10);

    assert.equal(version.taskId, 10);
    assert.equal(version.taskName, 'New Laptop');
    assert.equal(version.teamId, 7);
    assert.equal(version.versionId, 55);
    assert.equal(version.versionNo, 2);
    assert.equal(version.supportNotes, 'Check asset register first');
    assert.equal(version.fields.length, 1);

    // The header query is bound on the task id and joins the CURRENT version.
    const header = callWith(calls, 'JOIN task_version');
    assert.ok(header);
    assert.deepEqual(header.params, [10]);
    assert.match(header.text, /current_version_id/);

    // The field query is bound on the resolved version id and ordered.
    const fields = callWith(calls, 'JOIN data_point');
    assert.ok(fields);
    assert.deepEqual(fields.params, [55]);
    assert.match(fields.text, /ORDER BY tf\.field_order/);
  });

  it('takes name and data type from the data point and never from an override (R16.3)', async () => {
    const { db } = fakeDb((text) => {
      if (text.includes('JOIN task_version')) return [headerRow()];
      if (text.includes('JOIN data_point')) {
        return [
          {
            task_field_id: 101,
            data_point_id: 201,
            field_order: 1,
            is_mandatory: false,
            description_override: null,
            help_text_override: null,
            options_override: null,
            dp_name: 'Email',
            dp_data_type: 'EMAIL',
            dp_description: null,
            dp_default_help_text: null,
            dp_default_options: null,
            dp_regexp_pattern: null,
          },
        ];
      }
      return [];
    });
    const store = new DbWorkflowSupportStore(db);

    const [field] = (await store.getCurrentVersion(10)).fields;
    assert.equal(field.name, 'Email');
    assert.equal(field.dataType, 'EMAIL');
    assert.equal(field.isMandatory, false);
  });

  it('prefers the field description/help overrides over the data point defaults (R2.6)', async () => {
    const { db } = fakeDb((text) => {
      if (text.includes('JOIN task_version')) return [headerRow()];
      if (text.includes('JOIN data_point')) {
        return [
          {
            task_field_id: 102,
            data_point_id: 202,
            field_order: 0,
            is_mandatory: true,
            description_override: 'Overridden description',
            help_text_override: 'Overridden help',
            options_override: null,
            dp_name: 'Cost Centre',
            dp_data_type: 'TEXT',
            dp_description: 'Default description',
            dp_default_help_text: 'Default help',
            dp_default_options: null,
            dp_regexp_pattern: null,
          },
        ];
      }
      return [];
    });
    const store = new DbWorkflowSupportStore(db);

    const [field] = (await store.getCurrentVersion(10)).fields;
    assert.equal(field.description, 'Overridden description');
    assert.equal(field.helpText, 'Overridden help');
  });

  it('falls back to the data point description/help when no override is set (R2.6)', async () => {
    const { db } = fakeDb((text) => {
      if (text.includes('JOIN task_version')) return [headerRow()];
      if (text.includes('JOIN data_point')) {
        return [
          {
            task_field_id: 103,
            data_point_id: 203,
            field_order: 0,
            is_mandatory: false,
            description_override: null,
            help_text_override: null,
            options_override: null,
            dp_name: 'Notes',
            dp_data_type: 'TEXT',
            dp_description: 'Default description',
            dp_default_help_text: 'Default help',
            dp_default_options: null,
            dp_regexp_pattern: null,
          },
        ];
      }
      return [];
    });
    const store = new DbWorkflowSupportStore(db);

    const [field] = (await store.getCurrentVersion(10)).fields;
    assert.equal(field.description, 'Default description');
    assert.equal(field.helpText, 'Default help');
  });

  it('resolves a DROPDOWN to the task-level options override when provided (R3.5)', async () => {
    const { db } = fakeDb((text) => {
      if (text.includes('JOIN task_version')) return [headerRow()];
      if (text.includes('JOIN data_point')) {
        return [
          {
            task_field_id: 104,
            data_point_id: 204,
            field_order: 0,
            is_mandatory: true,
            description_override: null,
            help_text_override: null,
            options_override: ['High', 'Low'],
            dp_name: 'Priority',
            dp_data_type: 'DROPDOWN',
            dp_description: null,
            dp_default_help_text: null,
            dp_default_options: ['Critical', 'High', 'Medium', 'Low'],
            dp_regexp_pattern: null,
          },
        ];
      }
      return [];
    });
    const store = new DbWorkflowSupportStore(db);

    const [field] = (await store.getCurrentVersion(10)).fields;
    // Override list wins over the data point default (R3.5).
    assert.deepEqual(field.options, ['High', 'Low']);
  });

  it('resolves a DROPDOWN to the data point default when no override is set (R3.5)', async () => {
    const { db } = fakeDb((text) => {
      if (text.includes('JOIN task_version')) return [headerRow()];
      if (text.includes('JOIN data_point')) {
        return [
          {
            task_field_id: 105,
            data_point_id: 205,
            field_order: 0,
            is_mandatory: true,
            description_override: null,
            help_text_override: null,
            options_override: null,
            dp_name: 'Priority',
            dp_data_type: 'DROPDOWN',
            dp_description: null,
            dp_default_help_text: null,
            dp_default_options: ['Critical', 'High', 'Medium', 'Low'],
            dp_regexp_pattern: null,
          },
        ];
      }
      return [];
    });
    const store = new DbWorkflowSupportStore(db);

    const [field] = (await store.getCurrentVersion(10)).fields;
    // No override → fall back to the data point default list (R3.5).
    assert.deepEqual(field.options, ['Critical', 'High', 'Medium', 'Low']);
  });

  it('surfaces options only for DROPDOWN fields and the regexp only for REGEXP fields', async () => {
    const { db } = fakeDb((text) => {
      if (text.includes('JOIN task_version')) return [headerRow()];
      if (text.includes('JOIN data_point')) {
        return [
          {
            task_field_id: 106,
            data_point_id: 206,
            field_order: 0,
            is_mandatory: false,
            description_override: null,
            help_text_override: null,
            // A stray default_options on a non-dropdown must not leak through.
            options_override: null,
            dp_name: 'Employee Id',
            dp_data_type: 'REGEXP',
            dp_description: null,
            dp_default_help_text: null,
            dp_default_options: ['ignored'],
            dp_regexp_pattern: '^E\\d{5}$',
          },
        ];
      }
      return [];
    });
    const store = new DbWorkflowSupportStore(db);

    const [field] = (await store.getCurrentVersion(10)).fields;
    assert.equal(field.options, null); // not a dropdown → no option list
    assert.equal(field.regexpPattern, '^E\\d{5}$'); // regexp surfaced
  });

  it('throws TaskNotFoundError when the task (or its current version) is absent', async () => {
    const { db, calls } = fakeDb(() => []); // header query finds nothing
    const store = new DbWorkflowSupportStore(db);

    await assert.rejects(
      () => store.getCurrentVersion(404),
      (e) => e instanceof TaskNotFoundError && (e as TaskNotFoundError).taskId === 404,
    );
    // No field query runs once the header is missing.
    assert.equal(callWith(calls, 'JOIN data_point'), undefined);
  });
});
