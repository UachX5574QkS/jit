import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../db/pool.js';
import { one, query, withTransaction, type Queryable } from '../db/query.js';
import { ApiError } from '../middleware/errors.js';
import type { Status } from '../status/index.js';
import {
  DbRequestSupportMutationsStore,
  type SupportActor,
} from './requests-support-mutations.store.js';
import {
  DbRequestUserMutationsStore,
  RequestForbiddenError,
  type MutationActor,
} from './requests-user-mutations.store.js';

/**
 * END-TO-END verification of the request STATUS LIFECYCLE and the raiser
 * CANCEL / REOPEN paths (task 16.2, R5 + R9) against the LIVE `helpdesk`
 * Postgres database, driving the REAL Postgres-backed stores that sit behind
 * the endpoints:
 *
 *   • support status endpoint (task 7.2, design `PATCH /api/requests/{id}`) →
 *     {@link DbRequestSupportMutationsStore.updateRequest} — the only path that
 *     moves a request through the general lifecycle (NEW → TRIAGE → … →
 *     COMPLETE plus the PAUSED/BLOCKED branches), state-machine checked (R9).
 *   • raiser cancel/reopen endpoints (task 6.5, design `POST .../cancel` and
 *     `POST .../reopen`) → {@link DbRequestUserMutationsStore.cancel} /
 *     `.reopen()` — the constrained raiser paths (R5.5–5.7).
 *
 * Nothing is mocked: the state machine, the mutation SQL, and the column-level
 * audit writes all run in real transactions, exactly as they do in production.
 * The frontend request-detail (task 11.2) and support-detail (12.2/12.3) are
 * thin surfaces over these stores; the design records status changes flowing
 * through this same state machine, so verifying the stores end-to-end verifies
 * the behaviour those screens expose.
 *
 * ── What R9 / R5 say must hold ───────────────────────────────────────────────
 *   • R9.4 — the full legal path is accepted: NEW → TRIAGE → ACCEPTED →
 *            ASSIGNED → ACTIVE → COMPLETE, and the ASSIGNED/ACTIVE →
 *            PAUSED/BLOCKED → ACTIVE branches.
 *   • R9.5 — COMPLETE is reachable ONLY from ACTIVE.
 *   • R9.6 — CANCELLED is reachable from any NON-stop state.
 *   • R9.7 — every other move is rejected with INVALID_TRANSITION, including any
 *            move OUT of a stop state (support cannot move a COMPLETE/CANCELLED
 *            request).
 *   • R7.7 / R17 — every accepted transition is audited (status old→new row).
 *   • R5.5 — the raiser may cancel from a non-stop state (→ CANCELLED).
 *   • R5.6 — only the raiser WHO CANCELLED may reopen (CANCELLED → NEW); a
 *            different raiser / a non-raiser cannot.
 *
 * ── Why the test builds its own fixtures ─────────────────────────────────────
 * Mirroring task 16.1 (reference-data-guards.e2e.test.ts), this drives a small,
 * uniquely-tagged DISPOSABLE fixture graph rather than mutating the shared seed
 * (task 15.1). Each lifecycle assertion gets its OWN fresh request so the state
 * machine is exercised from a known start state without cross-contamination.
 * All fixture SQL goes through the parameterised data-access layer, and the
 * whole graph is deleted afterwards so the seed is left untouched.
 *
 * ── DB availability ──────────────────────────────────────────────────────────
 * If the local Postgres is not reachable the whole suite is SKIPPED (not
 * failed): the state machine itself is additionally covered by status.test.ts
 * and the store unit tests, which run without a database.
 */

// A unique tag so fixtures never collide with the seed or a previous run.
const TAG = `e2e-r9-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Monotonic counters for unique fixture usernames / request references.
let userSeq = 0;
let reqSeq = 0;

/** IDs of the shared fixture rows, populated by {@link seedFixture}. */
interface Fixture {
  /** The raiser of every fixture request. */
  raiserId: number;
  /** A second raiser — used to prove a non-canceller cannot reopen (R5.6). */
  otherRaiserId: number;
  /** A support member of the fixture team (drives the support status endpoint). */
  supportId: number;
  teamId: number;
  dataPointId: number;
  taskId: number;
  taskVersionId: number;
  /** All request ids created, for teardown. */
  requestIds: number[];
}

let dbAvailable = false;
let fx: Fixture;

let supportStore: DbRequestSupportMutationsStore;
let userStore: DbRequestUserMutationsStore;

/** The actor context for the support-side status endpoint (member of the team). */
function supportActor(): SupportActor {
  return { userId: fx.supportId, teamsMemberOf: [fx.teamId] };
}

/** The actor context for a raiser (user-side cancel/reopen). */
function raiserActor(userId: number): MutationActor {
  return { userId, teamsMemberOf: [] };
}

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
  // 8-digit username (app_user CHECK): derive from a counter so it is unique.
  const username = String(80_000_000 + userSeq++);
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
 * Create a fresh fixture request at a KNOWN start status, assigned to the given
 * raiser, returning its id. Written straight to the DB so each lifecycle case
 * starts from a controlled state (the state machine is exercised via the stores,
 * not via how the row was seeded).
 */
async function insertRequest(
  status: Status,
  raisedById: number,
): Promise<number> {
  const ref = `${TAG}-REQ-${reqSeq++}`;
  const row = await one<{ id: string | number }>(
    `INSERT INTO request
       (task_reference, task_version_id, title, raised_by_id, team_id,
        assigned_member_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7::request_status)
     RETURNING id`,
    [ref, fx.taskVersionId, `Lifecycle fixture (${status})`, raisedById, fx.teamId, null, status],
  );
  const id = Number(row!.id);
  fx.requestIds.push(id);
  return id;
}

/** Read a request's current status straight from the DB. */
async function statusOf(requestId: number): Promise<Status> {
  const row = await one<{ status: Status }>(
    `SELECT status FROM request WHERE id = $1`,
    [requestId],
  );
  return row!.status;
}

/** Count status-change audit rows recording old→new for a request. */
async function statusAuditCount(
  requestId: number,
  from: Status,
  to: Status,
): Promise<number> {
  const row = await one<{ c: string | number }>(
    `SELECT COUNT(*) AS c
       FROM audit_entry
      WHERE entity_type = 'request'
        AND entity_id = $1
        AND field_name = 'status'
        AND old_value = $2
        AND new_value = $3`,
    [requestId, from, to],
  );
  return Number(row!.c);
}

/** Create the shared fixture graph in ONE transaction (parameterised throughout). */
async function seedFixture(): Promise<Fixture> {
  return withTransaction(async (tx) => {
    const raiserId = await insertUser(tx, 'raiser');
    const otherRaiserId = await insertUser(tx, 'other');
    const supportId = await insertUser(tx, 'support');

    const teamRow = await one<{ id: string | number }>(
      `INSERT INTO team (title, description, team_leader_id)
       VALUES ($1, $2, $3) RETURNING id`,
      [`${TAG} Team`, 'E2E R9 fixture team', supportId],
      tx,
    );
    const teamId = Number(teamRow!.id);

    // The support member must be a member of the team (support-mutation gate).
    await query(
      `INSERT INTO team_member (team_id, user_id) VALUES ($1, $2)
       ON CONFLICT (team_id, user_id) DO NOTHING`,
      [teamId, supportId],
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

    // One OPTIONAL field so the pinned version resolves but no mandatory value
    // is required for a status-only mutation.
    await query(
      `INSERT INTO task_field
         (task_version_id, data_point_id, field_order, is_mandatory, options_override)
       VALUES ($1, $2, 1, false, NULL)`,
      [taskVersionId, dataPointId],
      tx,
    );
    await query(
      `UPDATE task SET current_version_id = $1 WHERE id = $2`,
      [taskVersionId, taskId],
      tx,
    );

    return {
      raiserId,
      otherRaiserId,
      supportId,
      teamId,
      dataPointId,
      taskId,
      taskVersionId,
      requestIds: [],
    };
  });
}

/** Delete the entire fixture graph (child rows first) so the seed is untouched. */
async function teardownFixture(): Promise<void> {
  if (!fx) return;
  await withTransaction(async (tx) => {
    if (fx.requestIds.length > 0) {
      // audit_entry has no FK cascade; clear the status/other rows this test's
      // real store operations produced for the fixture requests.
      await query(
        `DELETE FROM audit_entry
          WHERE entity_type IN ('request', 'request_field_value')
            AND entity_id = ANY($1::bigint[])`,
        [fx.requestIds],
        tx,
      );
      await query(
        `DELETE FROM request_field_value WHERE request_id = ANY($1::bigint[])`,
        [fx.requestIds],
        tx,
      );
      await query(`DELETE FROM request WHERE id = ANY($1::bigint[])`, [fx.requestIds], tx);
    }
    await query(`DELETE FROM task_field WHERE task_version_id = $1`, [fx.taskVersionId], tx);
    await query(`UPDATE task SET current_version_id = NULL WHERE id = $1`, [fx.taskId], tx);
    await query(`DELETE FROM task_version WHERE task_id = $1`, [fx.taskId], tx);
    await query(`DELETE FROM task WHERE id = $1`, [fx.taskId], tx);
    await query(`DELETE FROM data_point WHERE id = $1`, [fx.dataPointId], tx);
    await query(`DELETE FROM team_member WHERE team_id = $1`, [fx.teamId], tx);
    await query(`DELETE FROM team WHERE id = $1`, [fx.teamId], tx);
    await query(
      `DELETE FROM app_user WHERE id IN ($1, $2, $3)`,
      [fx.raiserId, fx.otherRaiserId, fx.supportId],
      tx,
    );
  });
}

/**
 * Drive one support-side status change through the REAL store and assert the
 * request landed on `to` and the transition was audited (R7.7, R17).
 */
async function driveSupportTransition(
  requestId: number,
  from: Status,
  to: Status,
): Promise<void> {
  const before = await statusAuditCount(requestId, from, to);
  const summary = await supportStore.updateRequest(requestId, { status: to }, supportActor());
  assert.equal(summary.status, to, `store should report the new status ${to}`);
  assert.equal(await statusOf(requestId), to, `DB status should be ${to}`);
  const after = await statusAuditCount(requestId, from, to);
  assert.equal(after, before + 1, `transition ${from}→${to} must be audited exactly once`);
}

/** Assert a support-side status change is rejected with INVALID_TRANSITION and the status is unchanged. */
async function assertSupportRejected(
  requestId: number,
  to: Status,
): Promise<void> {
  const before = await statusOf(requestId);
  await assert.rejects(
    () => supportStore.updateRequest(requestId, { status: to }, supportActor()),
    (err: unknown) => {
      assert.ok(err instanceof ApiError, `expected ApiError, got ${String(err)}`);
      assert.equal(err.code, 'INVALID_TRANSITION');
      assert.equal(err.status, 409);
      return true;
    },
  );
  assert.equal(await statusOf(requestId), before, 'status must be unchanged after a rejected move');
}

describe('R9/R5 status lifecycle + raiser cancel/reopen — end-to-end against the live DB', () => {
  before(async () => {
    dbAvailable = await probeDb();
    if (!dbAvailable) return;
    fx = await seedFixture();
    supportStore = new DbRequestSupportMutationsStore();
    userStore = new DbRequestUserMutationsStore();
  });

  after(async () => {
    if (dbAvailable) {
      await teardownFixture();
    }
    await pool.end();
  });

  it('R9.4/R9.5 — the full legal path NEW→TRIAGE→ACCEPTED→ASSIGNED→ACTIVE→COMPLETE is accepted and audited', async (t) => {
    if (!dbAvailable) return t.skip('local Postgres not reachable');
    const id = await insertRequest('NEW', fx.raiserId);

    await driveSupportTransition(id, 'NEW', 'TRIAGE');
    await driveSupportTransition(id, 'TRIAGE', 'ACCEPTED');
    await driveSupportTransition(id, 'ACCEPTED', 'ASSIGNED');
    await driveSupportTransition(id, 'ASSIGNED', 'ACTIVE');
    // COMPLETE is reachable ONLY from ACTIVE (R9.5): here we are in ACTIVE.
    await driveSupportTransition(id, 'ACTIVE', 'COMPLETE');
  });

  it('R9.4 — the ASSIGNED→PAUSED→ACTIVE and ACTIVE→BLOCKED→ACTIVE branches are accepted', async (t) => {
    if (!dbAvailable) return t.skip('local Postgres not reachable');
    const id = await insertRequest('NEW', fx.raiserId);

    await driveSupportTransition(id, 'NEW', 'TRIAGE');
    await driveSupportTransition(id, 'TRIAGE', 'ACCEPTED');
    await driveSupportTransition(id, 'ACCEPTED', 'ASSIGNED');
    // ASSIGNED → PAUSED → ACTIVE
    await driveSupportTransition(id, 'ASSIGNED', 'PAUSED');
    await driveSupportTransition(id, 'PAUSED', 'ACTIVE');
    // ACTIVE → BLOCKED → ACTIVE
    await driveSupportTransition(id, 'ACTIVE', 'BLOCKED');
    await driveSupportTransition(id, 'BLOCKED', 'ACTIVE');
    // TRIAGE → REJECTED is exercised on its own request below; here close out.
    await driveSupportTransition(id, 'ACTIVE', 'COMPLETE');
  });

  it('R9.4 — TRIAGE→REJECTED is accepted', async (t) => {
    if (!dbAvailable) return t.skip('local Postgres not reachable');
    const id = await insertRequest('NEW', fx.raiserId);
    await driveSupportTransition(id, 'NEW', 'TRIAGE');
    await driveSupportTransition(id, 'TRIAGE', 'REJECTED');
  });

  it('R9.5/R9.7 — COMPLETE is rejected from a non-ACTIVE state (INVALID_TRANSITION)', async (t) => {
    if (!dbAvailable) return t.skip('local Postgres not reachable');
    // NEW is not ACTIVE, so NEW → COMPLETE must be rejected.
    const fromNew = await insertRequest('NEW', fx.raiserId);
    await assertSupportRejected(fromNew, 'COMPLETE');

    // ASSIGNED is not ACTIVE either.
    const fromAssigned = await insertRequest('ASSIGNED', fx.raiserId);
    await assertSupportRejected(fromAssigned, 'COMPLETE');
  });

  it('R9.7 — arbitrary illegal jumps are rejected (NEW→ACTIVE, ACCEPTED→COMPLETE)', async (t) => {
    if (!dbAvailable) return t.skip('local Postgres not reachable');
    const fromNew = await insertRequest('NEW', fx.raiserId);
    await assertSupportRejected(fromNew, 'ACTIVE');

    const fromAccepted = await insertRequest('ACCEPTED', fx.raiserId);
    await assertSupportRejected(fromAccepted, 'COMPLETE');
  });

  it('R9.3/R9.7 — moves OUT of a stop state are rejected (COMPLETE→NEW, CANCELLED→ACTIVE, REJECTED→TRIAGE)', async (t) => {
    if (!dbAvailable) return t.skip('local Postgres not reachable');
    const fromComplete = await insertRequest('COMPLETE', fx.raiserId);
    await assertSupportRejected(fromComplete, 'NEW');

    const fromCancelled = await insertRequest('CANCELLED', fx.raiserId);
    await assertSupportRejected(fromCancelled, 'ACTIVE');

    const fromRejected = await insertRequest('REJECTED', fx.raiserId);
    await assertSupportRejected(fromRejected, 'TRIAGE');
  });

  it('R9.6 — support can CANCEL from any non-stop state (e.g. ASSIGNED→CANCELLED)', async (t) => {
    if (!dbAvailable) return t.skip('local Postgres not reachable');
    const id = await insertRequest('ASSIGNED', fx.raiserId);
    await driveSupportTransition(id, 'ASSIGNED', 'CANCELLED');
  });

  it('R5.5/R5.6 — the raiser cancels from a non-stop state and only the raiser-who-cancelled can reopen', async (t) => {
    if (!dbAvailable) return t.skip('local Postgres not reachable');
    const id = await insertRequest('TRIAGE', fx.raiserId);

    // R5.5 — the raiser cancels from a non-stop state (→ CANCELLED), audited.
    const cancelled = await userStore.cancel(id, raiserActor(fx.raiserId));
    assert.equal(cancelled.status, 'CANCELLED', 'raiser cancel should land on CANCELLED');
    assert.equal(await statusOf(id), 'CANCELLED');
    assert.equal(
      await statusAuditCount(id, 'TRIAGE', 'CANCELLED'),
      1,
      'cancel must be audited (records who cancelled — gates reopen)',
    );

    // R5.6 — the SAME raiser who cancelled reopens it (CANCELLED → NEW).
    const reopened = await userStore.reopen(id, raiserActor(fx.raiserId));
    assert.equal(reopened.status, 'NEW', 'raiser-who-cancelled reopen should return to NEW');
    assert.equal(await statusOf(id), 'NEW');
    assert.equal(
      await statusAuditCount(id, 'CANCELLED', 'NEW'),
      1,
      'reopen must be audited as CANCELLED→NEW',
    );
  });

  it('R5.6 — a DIFFERENT raiser (not the canceller) cannot reopen a cancelled request', async (t) => {
    if (!dbAvailable) return t.skip('local Postgres not reachable');
    // Raised by otherRaiser; support cancels it (so the canceller is support,
    // not either raiser). The reopen gate reads WHO cancelled from the audit.
    const id = await insertRequest('ASSIGNED', fx.otherRaiserId);
    await driveSupportTransition(id, 'ASSIGNED', 'CANCELLED');

    // The raiser is otherRaiser, but they did NOT cancel it → FORBIDDEN (R5.6).
    await assert.rejects(
      () => userStore.reopen(id, raiserActor(fx.otherRaiserId)),
      (err: unknown) => {
        assert.ok(
          err instanceof RequestForbiddenError,
          `expected RequestForbiddenError, got ${String(err)}`,
        );
        return true;
      },
    );
    assert.equal(await statusOf(id), 'CANCELLED', 'status must stay CANCELLED after a rejected reopen');
  });

  it('R5.6 — a non-raiser cannot reopen even a request they cancelled is guarded by the raiser check', async (t) => {
    if (!dbAvailable) return t.skip('local Postgres not reachable');
    // Raised by raiser, cancelled by raiser (legitimate). A non-raiser (support)
    // attempting reopen is rejected by the raiser-only gate (R5.6).
    const id = await insertRequest('TRIAGE', fx.raiserId);
    await userStore.cancel(id, raiserActor(fx.raiserId));

    await assert.rejects(
      () => userStore.reopen(id, raiserActor(fx.supportId)),
      (err: unknown) => {
        assert.ok(
          err instanceof RequestForbiddenError,
          `expected RequestForbiddenError, got ${String(err)}`,
        );
        return true;
      },
    );
    assert.equal(await statusOf(id), 'CANCELLED', 'status must stay CANCELLED');
  });
});
