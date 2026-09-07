import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMigrationFile,
  orderMigrations,
  pendingMigrations,
  type Migration,
} from './migrate.js';

describe('isMigrationFile', () => {
  it('accepts regular .sql files', () => {
    assert.equal(isMigrationFile('0001_schema_migrations.sql'), true);
    assert.equal(isMigrationFile('0012_add_requests.sql'), true);
  });

  it('rejects non-.sql files', () => {
    assert.equal(isMigrationFile('README.md'), false);
    assert.equal(isMigrationFile('0001_schema_migrations.sql.bak'), false);
    assert.equal(isMigrationFile('notes.txt'), false);
  });

  it('rejects hidden files even with a .sql suffix', () => {
    assert.equal(isMigrationFile('.keep.sql'), false);
    assert.equal(isMigrationFile('.DS_Store'), false);
  });
});

describe('orderMigrations', () => {
  it('sorts migrations by zero-padded filename ascending', () => {
    const ordered = orderMigrations([
      '0003_c.sql',
      '0001_a.sql',
      '0002_b.sql',
    ]);
    assert.deepEqual(
      ordered.map((m) => m.version),
      ['0001_a', '0002_b', '0003_c'],
    );
  });

  it('derives the version from the filename without the .sql extension', () => {
    const [m] = orderMigrations(['0001_schema_migrations.sql']);
    assert.equal(m?.version, '0001_schema_migrations');
    assert.equal(m?.filename, '0001_schema_migrations.sql');
  });

  it('filters out non-migration files (README, hidden, backups)', () => {
    const ordered = orderMigrations([
      'README.md',
      '.hidden.sql',
      '0001_a.sql',
      '0002_b.sql.bak',
    ]);
    assert.deepEqual(
      ordered.map((m) => m.filename),
      ['0001_a.sql'],
    );
  });

  it('is deterministic and does not mutate its input', () => {
    const input = ['0002_b.sql', '0001_a.sql'];
    const copy = [...input];
    orderMigrations(input);
    assert.deepEqual(input, copy);
  });
});

describe('pendingMigrations', () => {
  const ordered: Migration[] = orderMigrations([
    '0001_a.sql',
    '0002_b.sql',
    '0003_c.sql',
  ]);

  it('returns all migrations when none have been applied', () => {
    const pending = pendingMigrations(ordered, new Set());
    assert.deepEqual(
      pending.map((m) => m.version),
      ['0001_a', '0002_b', '0003_c'],
    );
  });

  it('skips already-applied versions while preserving order', () => {
    const pending = pendingMigrations(ordered, new Set(['0001_a']));
    assert.deepEqual(
      pending.map((m) => m.version),
      ['0002_b', '0003_c'],
    );
  });

  it('returns nothing when every migration has been applied (idempotency)', () => {
    const applied = new Set(['0001_a', '0002_b', '0003_c']);
    assert.deepEqual(pendingMigrations(ordered, applied), []);
  });

  it('ignores applied versions that are not on disk', () => {
    const pending = pendingMigrations(ordered, new Set(['9999_gone']));
    assert.equal(pending.length, 3);
  });
});
