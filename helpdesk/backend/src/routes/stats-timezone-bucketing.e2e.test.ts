import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db/pool.js';
import { one, query, withTransaction, type Queryable } from '../db/query.js';
import type { ManagerGraph, ManagerGraphLoader, UserId } from '../hierarchy/index.js';
import { DbUserStatsStore } from './stats-user.store.js';
import { DbTeamStatsStore } from './stats-team.store.js';
import { DbSupportStatsStore } from './stats-support.store.js';

/**
 * END-TO-END verification of R18 month bucketing (task 16.3) against the LIVE
 * `helpdesk` Postgres database, driving the REAL Postgres-backed statistics
 * stores (`DbUserStatsStore`, `DbTeamStatsStore`, `DbSupportStatsStore`).
 * Nothing is mocked in the SQL path: the `date_trunc('month', created_at AT
 * TIME ZONE $tz)` rebasing runs inside Postgres, exactly as it does behind
 * `GET /api/stats/{user,team,support}`.
 *
 * ── What R18.3 says the bucketing must do ────────────────────────────────────
 * Statistics are grouped "by month" using the VIEWER'S timezone (R18.3), and
 * every timestamp is stored WITH its timezone (R18.1). So a single stored
 * instant can belong to DIFFERENT calendar months for two viewers in different
 * zones. The canonical case is the end-of-month boundary: an event at 23:30 UTC
 * on the last day of a month is still January for a UTC viewer, but is already
 * 08:30 on the 1st of February for a +09:00 viewer (Asia/Tokyo) — so it buckets
 * into `2026-02` for them and `2026-01` for the UTC viewer. This is the whole
 * point of computing the bucket in the viewer's zone rather than in UTC.
 *
 * This suite proves that end-to-end for a REAL request row whose `created_at`
 * sits exactly on that boundary, across all three stats stores (they share the
 * identical bucketing SQL; the unit tests already prove the tz is BOUND and the
 * SQL text is identical between viewers — this proves the DB actually re-buckets
 * the instant). The complementary R18.2 rendering property (a UTC instant shown
 * in the viewer's browser-local zone) is covered by the frontend
 * `local-date.pipe.spec.ts`, and the `?tz` propagation from
 * `TimezoneService.resolve()` by the statistics component/service specs.
 *
 * ── Why the test builds its own fixture ──────────────────────────────────────
 * The dev seed (task 15.1) does not guarantee a request whose `created_at`
 * lands on a month boundary, and mutating a seeded row's timestamp would
 * pollute shared data. So — as in the 16.1/16.2 e2e suites — this test creates
 * a small, uniquely-tagged fixture graph (one raiser, one team, one task over a
 * fresh data point, and one request pinned to the boundary instant), runs the
 * real stores against it, and deletes the fixture afterwards. All fixture SQL
 * goes through the parameterised data-access layer (R22.2/R22.4).
 *
 * ── DB availability ──────────────────────────────────────────────────────────
 * If the local Postgres is not reachable the whole suite is SKIPPED (not
 * failed): the bucketing SQL shape is additionally covered by the store unit
 * tests (stats-*.store.test.ts), which run without a database.
 */

// A unique tag so fixtures never collide with the seed or a previous run.
const TAG = `e2e-r18-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// The boundary instant under test: 23:30 UTC on the last day of January 2026.
//   • UTC viewer         → still 2026-01-31 23:30 → bucket 2026-01
//   • Asia/Tokyo (+09:00) → 2026-02-01 08:30       → bucket 2026-02
const BOUNDARY_INSTANT = '2026-01-31T23:30:00.000Z';
const ZONE_BEFORE = 'UTC';
const ZONE_AFTER = 'Asia/Tokyo';
const MONTH_BEFORE = '2026-01';
const MONTH_AFTER = '2026-02';

// Monotonic counter for unique 8-digit fixture usernames.
let userSeq = 0;

/** IDs of the fixture rows, populated by {@link seedFixture}. */
interface Fixture {
  raiserId: number;
  /** A synthetic manager id used only to build the fake hierarchy graph. */
  managerId: number;
  teamId: number;
  dataPointId: number;
  taskId: number;
  taskVersionId: number;
  /** The request whose created_at is pinned to the boundary instant. */
  requestId: number;
}

let dbAvailable = false;
let fx: Fixture;

/** Probe the database once; used to skip the suite when it is unreachable. */
async function probeDb(): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

/** Insert a disposable app_user and return its id. */
async function insertUser(tx: Queryable, suffix: string): Promise<number> {
  // 8-digit username (app_user CHECK): derive deterministically from a counter
  // so it is unique but valid.
  const username = String(91_000_000 + userSeq++);
  const row = await one<{ id: string | number }>(
    `INSERT INTO app_user
       (username, first_name, surname, email, manager_id, password_hash, timezone)
     VALUES ($1, $2, $3, $4, NULL, $5, $6)
     RETURNING id`,
    [
      username,
      `Fx${suffix}`,
      TAG,
      `${username}@example.com`,
      'x', // placeholder hash — never authenticated in this test
      'Europe/London',
    ],
    tx,
  );
  return Number(row!.id);
}

/**
 * Create the fixture graph in ONE transaction (parameterised throughout). The
 * single request's `created_at` is set EXPLICITLY to the boundary instant so
 * the bucketing behaviour is deterministic regardless of when the test runs.
 */
async function seedFixture(): Promise<Fixture> {
  return withTransaction(async (tx) => {
    const managerId = await insertUser(tx, 'mgr');
    const raiserId = await insertUser(tx, 'raiser');

    const teamRow = await one<{ id: string | number }>(
      `INSERT INTO team (title, description, team_leader_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [`${TAG} Team`, 'E2E R18 fixture team', managerId],
      tx,
    );
    const teamId = Number(teamRow!.id);

    // The raiser is a member of the team so the support-stats team scope picks
    // the request up (support stats scope by team_id).
    await query(
      `INSERT INTO team_member (team_id, user_id) VALUES ($1, $2)
       ON CONFLICT (team_id, user_id) DO NOTHING`,
      [teamId, raiserId],
      tx,
    );

    const dpRow = await one<{ id: string | number }>(
      `INSERT INTO data_point
         (name, data_type, description, default_help_text, regexp_pattern, default_options)
       VALUES ($1, 'TEXT', $2, $3, NULL, NULL)
       RETURNING id`,
      [`${TAG} Summary`, 'E2E fixture data point', 'Help text'],
      tx,
    );
    const dataPointId = Number(dpRow!.id);

    const taskRow = await one<{ id: string | number }>(
      `INSERT INTO task (team_id, name) VALUES ($1, $2) RETURNING id`,
      [teamId, `${TAG} Task`],
      tx,
    );
    const taskId = Number(taskRow!.id);

    const versionRow = await one<{ id: string | number }>(
      `INSERT INTO task_version (task_id, version_no, support_notes)
       VALUES ($1, 1, $2) RETURNING id`,
      [taskId, 'Fixture support notes'],
      tx,
    );
    const taskVersionId = Number(versionRow!.id);

    await query(
      `INSERT INTO task_field
         (task_version_id, data_point_id, field_order, is_mandatory, options_override)
       VALUES ($1, $2, 1, true, NULL)`,
      [taskVersionId, dataPointId],
      tx,
    );
    await query(
      `UPDATE task SET current_version_id = $1 WHERE id = $2`,
      [taskVersionId, taskId],
      tx,
    );

    // The request under test. created_at is bound as a timestamptz value on the
    // boundary instant. The value travels as a parameter (R22.2), and because
    // the column is timestamptz the instant is stored WITH its zone (R18.1).
    const req = await one<{ id: string | number }>(
      `INSERT INTO request
         (task_reference, task_version_id, title, raised_by_id, team_id,
          assigned_member_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'NEW', $7::timestamptz, $7::timestamptz)
       RETURNING id`,
      [
        `${TAG}-BOUNDARY`,
        taskVersionId,
        'Month-boundary fixture request',
        raiserId,
        teamId,
        raiserId,
        BOUNDARY_INSTANT,
      ],
      tx,
    );
    const requestId = Number(req!.id);

    return {
      raiserId,
      managerId,
      teamId,
      dataPointId,
      taskId,
      taskVersionId,
      requestId,
    };
  });
}

/** Delete the entire fixture graph (child rows first) so the seed is untouched. */
async function teardownFixture(): Promise<void> {
  if (!fx) return;
  await withTransaction(async (tx) => {
    await query(`DELETE FROM request_field_value WHERE request_id = $1`, [fx.requestId], tx);
    await query(`DELETE FROM request WHERE id = $1`, [fx.requestId], tx);
    await query(`DELETE FROM task_field WHERE task_version_id = $1`, [fx.taskVersionId], tx);
    await query(`UPDATE task SET current_version_id = NULL WHERE id = $1`, [fx.taskId], tx);
    await query(`DELETE FROM task_version WHERE task_id = $1`, [fx.taskId], tx);
    await query(`DELETE FROM task WHERE id = $1`, [fx.taskId], tx);
    await query(`DELETE FROM data_point WHERE id = $1`, [fx.dataPointId], tx);
    await query(`DELETE FROM team_member WHERE team_id = $1`, [fx.teamId], tx);
    await query(`DELETE FROM team WHERE id = $1`, [fx.teamId], tx);
    await query(
      `DELETE FROM app_user WHERE id IN ($1, $2)`,
      [fx.raiserId, fx.managerId],
      tx,
    );
  });
}

/**
 * The count our fixture request should contribute to a (month, status) bucket:
 * exactly one NEW request. Helper reads the count for the given month out of a
 * status-by-month dataset, defaulting to 0 when the month is absent.
 */
function countForMonth(
  buckets: ReadonlyArray<{ month: string; status: string; count: number }>,
  month: string,
): number {
  return buckets
    .filter((b) => b.month === month && b.status === 'NEW')
    .reduce((acc, b) => acc + b.count, 0);
}

/**
 * A fake {@link ManagerGraphLoader} that makes the fixture raiser a direct
 * report of the synthetic manager, so `DbTeamStatsStore` (which scopes to the
 * viewer's DOWNWARD hierarchy) includes the raiser's requests when the manager
 * is the viewer. Only the graph is faked — every stats SQL statement still runs
 * against the live DB.
 */
function fakeGraphLoader(managerId: number, raiserId: number): ManagerGraphLoader {
  return {
    async load(): Promise<ManagerGraph> {
      return {
        directReports: new Map<UserId, Set<UserId>>([
          [managerId, new Set<UserId>([raiserId])],
        ]),
        areaManagerIds: new Set<UserId>(),
      };
    },
  };
}

describe('R18.3 month bucketing — end-to-end against the live DB', () => {
  before(async () => {
    dbAvailable = await probeDb();
    if (!dbAvailable) return;
    fx = await seedFixture();
  });

  after(async () => {
    if (dbAvailable) {
      await teardownFixture();
    }
    await pool.end();
  });

  it('User Statistics: the boundary instant buckets into different months per viewer timezone (R18.3)', async (t) => {
    if (!dbAvailable) return t.skip('local Postgres not reachable');
    const store = new DbUserStatsStore();

    const utcView = await store.getUserStats({ userId: fx.raiserId, timezone: ZONE_BEFORE });
    const tokyoView = await store.getUserStats({ userId: fx.raiserId, timezone: ZONE_AFTER });

    // UTC viewer: still January; Tokyo (+09:00) viewer: rolled into February.
    assert.equal(countForMonth(utcView.statusByMonth, MONTH_BEFORE), 1, 'UTC → 2026-01');
    assert.equal(countForMonth(utcView.statusByMonth, MONTH_AFTER), 0, 'UTC not in 2026-02');
    assert.equal(countForMonth(tokyoView.statusByMonth, MONTH_AFTER), 1, 'Tokyo → 2026-02');
    assert.equal(countForMonth(tokyoView.statusByMonth, MONTH_BEFORE), 0, 'Tokyo not in 2026-01');

    // The SAME instant landed in DIFFERENT months for the two viewers — the
    // essence of R18.3. The month strings the store returned must differ.
    const utcMonth = utcView.statusByMonth.find((b) => b.status === 'NEW')?.month;
    const tokyoMonth = tokyoView.statusByMonth.find((b) => b.status === 'NEW')?.month;
    assert.equal(utcMonth, MONTH_BEFORE);
    assert.equal(tokyoMonth, MONTH_AFTER);
    assert.notEqual(utcMonth, tokyoMonth, 'the same instant must bucket differently per zone');
  });

  it('User Statistics: the same viewer timezone buckets the instant consistently (stable)', async (t) => {
    if (!dbAvailable) return t.skip('local Postgres not reachable');
    const store = new DbUserStatsStore();

    const a = await store.getUserStats({ userId: fx.raiserId, timezone: ZONE_AFTER });
    const b = await store.getUserStats({ userId: fx.raiserId, timezone: ZONE_AFTER });
    assert.deepEqual(a.statusByMonth, b.statusByMonth, 'same tz → identical buckets');
  });

  it('Team Statistics: hierarchy-scoped bucketing shifts with the viewer timezone (R11.2 → R18.3)', async (t) => {
    if (!dbAvailable) return t.skip('local Postgres not reachable');
    // The team-stats store scopes to the viewer's downward hierarchy; a fake
    // graph makes the raiser a report of the synthetic manager so their single
    // request is in scope. The bucketing SQL is the live DB's.
    const loader = fakeGraphLoader(fx.managerId, fx.raiserId);

    const utcView = await new DbTeamStatsStore(pool, loader).getTeamStats({
      userId: fx.managerId,
      timezone: ZONE_BEFORE,
    });
    const tokyoView = await new DbTeamStatsStore(pool, loader).getTeamStats({
      userId: fx.managerId,
      timezone: ZONE_AFTER,
    });

    assert.equal(countForMonth(utcView.statusByMonth, MONTH_BEFORE), 1, 'UTC → 2026-01');
    assert.equal(countForMonth(tokyoView.statusByMonth, MONTH_AFTER), 1, 'Tokyo → 2026-02');
    assert.equal(countForMonth(utcView.statusByMonth, MONTH_AFTER), 0);
    assert.equal(countForMonth(tokyoView.statusByMonth, MONTH_BEFORE), 0);
  });

  it('Support Statistics: team-scoped bucketing shifts with the viewer timezone (R12.2 → R18.3)', async (t) => {
    if (!dbAvailable) return t.skip('local Postgres not reachable');
    const store = new DbSupportStatsStore();

    const utcView = await store.getSupportStats({
      teamIds: [fx.teamId],
      timezone: ZONE_BEFORE,
    });
    const tokyoView = await store.getSupportStats({
      teamIds: [fx.teamId],
      timezone: ZONE_AFTER,
    });

    assert.equal(countForMonth(utcView.statusByMonth, MONTH_BEFORE), 1, 'UTC → 2026-01');
    assert.equal(countForMonth(tokyoView.statusByMonth, MONTH_AFTER), 1, 'Tokyo → 2026-02');
    assert.equal(countForMonth(utcView.statusByMonth, MONTH_AFTER), 0);
    assert.equal(countForMonth(tokyoView.statusByMonth, MONTH_BEFORE), 0);
  });
});
