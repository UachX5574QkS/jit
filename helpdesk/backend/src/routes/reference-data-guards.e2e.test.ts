import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db/pool.js';
import { one, query, withTransaction, type Queryable } from '../db/query.js';
import { STOP_STATES } from '../status/index.js';
import {
  DbTeamAdminStore,
  OpenRequestsConflictError,
} from './team-admin.store.js';
import {
  DbTeamLeaderStore,
  MemberRemovalConflictError,
} from './team-leader.store.js';
import { DbTaskLeaderStore } from './task-leader.store.js';
import { DbDataPointStore } from '../admin/data-point-store.js';

/**
 * END-TO-END verification of the reference-data lifecycle guards (task 16.1,
 * R20) against the LIVE `helpdesk` Postgres database, driving the REAL
 * Postgres-backed stores (`DbTeamAdminStore`, `DbTeamLeaderStore`,
 * `DbTaskLeaderStore`, `DbDataPointStore`). Nothing is mocked: the guard SQL,
 * the mutations, and their column-level audit writes all run in real
 * transactions, exactly as they do behind the admin/team-leader endpoints.
 *
 * ── What R20 says the guards must do ─────────────────────────────────────────
 *   • R20.2 — a team with any non-closed request may NOT be closed
 *             (→ CONFLICT_OPEN_REQUESTS); the team stays open.
 *   • R20.3 — a support member with any non-closed request assigned to them
 *             under a team may NOT be removed from that team
 *             (→ CONFLICT_OPEN_REQUESTS); the member stays.
 *   • R20.1 / R20.4 — closing a team, retiring a task, and retiring a data
 *             point RETAIN all existing requests, and retired tasks / data
 *             points stay OPERATIONAL for the versions/requests already using
 *             them. (Retirement is a flag flip, not a blocked operation; the
 *             invariant to prove is retention + continued resolvability.)
 *   • The POSITIVE cases must succeed: closing a team once its requests are all
 *             closed, removing a member with no non-closed requests, and
 *             retiring reference data.
 *
 * ── Why the test builds its own fixtures ─────────────────────────────────────
 * The dev seed (task 15.1) leaves EVERY team with open requests and no closed
 * team, so there is no ready-made "unblocked" team/member to exercise the
 * positive path against. Rather than mutate the shared seed, this test creates
 * a small, uniquely-tagged fixture graph (one team, two members, one task with
 * one field over a fresh data point, and a handful of requests), runs the real
 * stores against it, and deletes the fixture afterwards — the seed is left
 * untouched. All fixture SQL goes through the parameterised data-access layer.
 *
 * ── DB availability ──────────────────────────────────────────────────────────
 * If the local Postgres is not reachable the whole suite is SKIPPED (not
 * failed): the guard logic itself is additionally covered by the store unit
 * tests (…store.test.ts) which run without a database.
 */

// A unique tag so fixtures never collide with the seed or a previous run.
const TAG = `e2e-r20-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const stopArray = [...STOP_STATES];

// Monotonic counter for unique 8-digit fixture usernames.
let userSeq = 0;

/** IDs of the fixture rows, populated by {@link seedFixture}. */
interface Fixture {
  adminId: number;
  leaderId: number;
  /** A member who WILL have a non-closed request assigned (removal blocked). */
  busyMemberId: number;
  /** A member with NO non-closed requests (removal allowed). */
  freeMemberId: number;
  teamId: number;
  dataPointId: number;
  taskId: number;
  taskVersionId: number;
  /** A NEW (non-closed) request assigned to the busy member. */
  openRequestId: number;
  /** A COMPLETE (closed) request — proves retention across retire/close. */
  closedRequestId: number;
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
  // baked into the tag so it is unique but valid.
  const username = String(90_000_000 + userSeq++);
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
 * Create the fixture graph in ONE transaction (parameterised throughout) and
 * capture its ids. Requests: one NEW (open) assigned to the busy member, one
 * COMPLETE (closed) assigned to the busy member.
 */
async function seedFixture(): Promise<Fixture> {
  return withTransaction(async (tx) => {
    const adminId = await insertUser(tx, 'admin');
    const leaderId = await insertUser(tx, 'leader');
    const busyMemberId = await insertUser(tx, 'busy');
    const freeMemberId = await insertUser(tx, 'free');

    const teamRow = await one<{ id: string | number }>(
      `INSERT INTO team (title, description, team_leader_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [`${TAG} Team`, 'E2E R20 fixture team', leaderId],
      tx,
    );
    const teamId = Number(teamRow!.id);

    for (const uid of [leaderId, busyMemberId, freeMemberId]) {
      await query(
        `INSERT INTO team_member (team_id, user_id) VALUES ($1, $2)
         ON CONFLICT (team_id, user_id) DO NOTHING`,
        [teamId, uid],
        tx,
      );
    }

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

    const openReq = await one<{ id: string | number }>(
      `INSERT INTO request
         (task_reference, task_version_id, title, raised_by_id, team_id,
          assigned_member_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'NEW')
       RETURNING id`,
      [`${TAG}-OPEN`, taskVersionId, 'Open fixture request', leaderId, teamId, busyMemberId],
      tx,
    );
    const openRequestId = Number(openReq!.id);

    const closedReq = await one<{ id: string | number }>(
      `INSERT INTO request
         (task_reference, task_version_id, title, raised_by_id, team_id,
          assigned_member_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'COMPLETE')
       RETURNING id`,
      [`${TAG}-CLOSED`, taskVersionId, 'Closed fixture request', leaderId, teamId, busyMemberId],
      tx,
    );
    const closedRequestId = Number(closedReq!.id);

    return {
      adminId,
      leaderId,
      busyMemberId,
      freeMemberId,
      teamId,
      dataPointId,
      taskId,
      taskVersionId,
      openRequestId,
      closedRequestId,
    };
  });
}

/** Delete the entire fixture graph (child rows first) so the seed is untouched. */
async function teardownFixture(): Promise<void> {
  if (!fx) return;
  await withTransaction(async (tx) => {
    // audit_entry has no FK cascade in the schema; clear the rows this test's
    // real store operations produced for the fixture entities.
    await query(
      `DELETE FROM audit_entry
        WHERE (entity_type = 'team' AND entity_id = $1)
           OR (entity_type = 'team_member' AND entity_id = $1)
           OR (entity_type = 'task' AND entity_id = $2)
           OR (entity_type = 'data_point' AND entity_id = $3)`,
      [fx.teamId, fx.taskId, fx.dataPointId],
      tx,
    );
    await query(`DELETE FROM request_field_value WHERE request_id IN ($1, $2)`, [fx.openRequestId, fx.closedRequestId], tx);
    await query(`DELETE FROM request WHERE id IN ($1, $2)`, [fx.openRequestId, fx.closedRequestId], tx);
    await query(`DELETE FROM task_field WHERE task_version_id = $1`, [fx.taskVersionId], tx);
    await query(`UPDATE task SET current_version_id = NULL WHERE id = $1`, [fx.taskId], tx);
    await query(`DELETE FROM task_version WHERE task_id = $1`, [fx.taskId], tx);
    await query(`DELETE FROM task WHERE id = $1`, [fx.taskId], tx);
    await query(`DELETE FROM data_point WHERE id = $1`, [fx.dataPointId], tx);
    await query(`DELETE FROM team_member WHERE team_id = $1`, [fx.teamId], tx);
    await query(`DELETE FROM team WHERE id = $1`, [fx.teamId], tx);
    await query(
      `DELETE FROM app_user WHERE id IN ($1, $2, $3, $4)`,
      [fx.adminId, fx.leaderId, fx.busyMemberId, fx.freeMemberId],
      tx,
    );
  });
}

/** Read a team's is_closed flag straight from the DB (bypasses the store). */
async function teamIsClosed(teamId: number): Promise<boolean> {
  const row = await one<{ is_closed: boolean }>(
    `SELECT is_closed FROM team WHERE id = $1`,
    [teamId],
  );
  return row!.is_closed;
}

/** True when a team_member row still exists for (team, user). */
async function isMember(teamId: number, userId: number): Promise<boolean> {
  const row = await one<{ one: number }>(
    `SELECT 1 AS one FROM team_member WHERE team_id = $1 AND user_id = $2`,
    [teamId, userId],
  );
  return row != null;
}

/** Count a request row still present with the given id. */
async function requestExists(requestId: number): Promise<boolean> {
  const row = await one<{ one: number }>(
    `SELECT 1 AS one FROM request WHERE id = $1`,
    [requestId],
  );
  return row != null;
}

describe('R20 reference-data guards — end-to-end against the live DB', () => {
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

  it('R20.2 — closing a team with open requests is rejected and the team stays open', async (t) => {
    if (!dbAvailable) return t.skip('local Postgres not reachable');
    const store = new DbTeamAdminStore();

    await assert.rejects(
      () => store.update(fx.teamId, { isClosed: true }, fx.adminId),
      (err: unknown) => {
        assert.ok(
          err instanceof OpenRequestsConflictError,
          `expected OpenRequestsConflictError, got ${String(err)}`,
        );
        assert.equal(err.teamId, fx.teamId);
        assert.ok(err.openRequestCount >= 1, 'should report at least one open request');
        return true;
      },
    );

    // The guard aborted the transaction: the team must still be OPEN (R20.2)…
    assert.equal(await teamIsClosed(fx.teamId), false, 'team must remain open');
    // …and both requests retained (R20.1).
    assert.equal(await requestExists(fx.openRequestId), true);
    assert.equal(await requestExists(fx.closedRequestId), true);
  });

  it('R20.3 — removing a member with non-closed requests is rejected and the member stays', async (t) => {
    if (!dbAvailable) return t.skip('local Postgres not reachable');
    const store = new DbTeamLeaderStore();

    await assert.rejects(
      () => store.update(fx.teamId, { removeMemberIds: [fx.busyMemberId] }, fx.leaderId),
      (err: unknown) => {
        assert.ok(
          err instanceof MemberRemovalConflictError,
          `expected MemberRemovalConflictError, got ${String(err)}`,
        );
        assert.equal(err.teamId, fx.teamId);
        assert.equal(err.userId, fx.busyMemberId);
        assert.ok(err.openRequestCount >= 1);
        return true;
      },
    );

    // The busy member must remain on the team (R20.3).
    assert.equal(await isMember(fx.teamId, fx.busyMemberId), true, 'busy member must stay');
  });

  it('R20.3 (positive) — removing a member with NO non-closed requests succeeds', async (t) => {
    if (!dbAvailable) return t.skip('local Postgres not reachable');
    const store = new DbTeamLeaderStore();

    // Sanity: the free member has no non-closed assigned requests under the team.
    const openForFree = await one<{ c: string | number }>(
      `SELECT COUNT(*) AS c FROM request
        WHERE team_id = $1 AND assigned_member_id = $2
          AND status <> ALL($3::request_status[])`,
      [fx.teamId, fx.freeMemberId, stopArray],
    );
    assert.equal(Number(openForFree!.c), 0, 'free member should have no open requests');

    const result = await store.update(
      fx.teamId,
      { removeMemberIds: [fx.freeMemberId] },
      fx.leaderId,
    );
    // The removal succeeded: the member is gone from the returned membership…
    assert.ok(
      !result.members.some((m) => m.userId === fx.freeMemberId),
      'free member should be removed from the returned membership',
    );
    // …and from the DB.
    assert.equal(await isMember(fx.teamId, fx.freeMemberId), false, 'free member removed');
  });

  it('R20.4 — retiring a task in use RETAINS it and keeps existing requests resolvable', async (t) => {
    if (!dbAvailable) return t.skip('local Postgres not reachable');
    const store = new DbTaskLeaderStore();

    const view = await store.retire(fx.taskId, fx.leaderId);
    assert.equal(view.isRetired, true, 'task should report retired');

    // The task row is retained (not deleted) and flagged retired…
    const taskRow = await one<{ is_retired: boolean; current_version_id: string | number | null }>(
      `SELECT is_retired, current_version_id FROM task WHERE id = $1`,
      [fx.taskId],
    );
    assert.ok(taskRow, 'task must still exist after retire');
    assert.equal(taskRow.is_retired, true);

    // …and the request raised against its pinned version still resolves that
    // version's task_field(s): retirement does not break existing requests.
    const fieldCount = await one<{ c: string | number }>(
      `SELECT COUNT(*) AS c
         FROM request r
         JOIN task_field tf ON tf.task_version_id = r.task_version_id
        WHERE r.id = $1`,
      [fx.openRequestId],
    );
    assert.ok(Number(fieldCount!.c) >= 1, 'existing request must still resolve its pinned fields');
  });

  it('R20.4 — retiring a data point in use RETAINS it and keeps the task version usable', async (t) => {
    if (!dbAvailable) return t.skip('local Postgres not reachable');
    const store = new DbDataPointStore();

    const retired = await store.retire(fx.dataPointId);
    assert.ok(retired, 'retire should return the data point');
    assert.equal(retired.isRetired, true);

    // The data point row is retained and the task_field referencing it still
    // resolves — the version already using it stays operational (R20.4).
    const stillLinked = await one<{ c: string | number }>(
      `SELECT COUNT(*) AS c
         FROM task_field tf
         JOIN data_point dp ON dp.id = tf.data_point_id
        WHERE tf.task_version_id = $1 AND dp.id = $2`,
      [fx.taskVersionId, fx.dataPointId],
    );
    assert.equal(Number(stillLinked!.c), 1, 'retired data point must remain linked & resolvable');
  });

  it('R20.2 (positive) — a team whose requests are all closed can be closed', async (t) => {
    if (!dbAvailable) return t.skip('local Postgres not reachable');
    const store = new DbTeamAdminStore();

    // Close out the only open request so the team has NO non-closed requests.
    await query(`UPDATE request SET status = 'CANCELLED' WHERE id = $1`, [fx.openRequestId]);
    const openCount = await one<{ c: string | number }>(
      `SELECT COUNT(*) AS c FROM request
        WHERE team_id = $1 AND status <> ALL($2::request_status[])`,
      [fx.teamId, stopArray],
    );
    assert.equal(Number(openCount!.c), 0, 'team should now have no open requests');

    const updated = await store.update(fx.teamId, { isClosed: true }, fx.adminId);
    assert.equal(updated.isClosed, true, 'close should succeed');
    assert.equal(await teamIsClosed(fx.teamId), true, 'team must be closed in the DB');

    // Retention (R20.1): closing the team keeps its existing requests.
    assert.equal(await requestExists(fx.openRequestId), true);
    assert.equal(await requestExists(fx.closedRequestId), true);
  });
});
