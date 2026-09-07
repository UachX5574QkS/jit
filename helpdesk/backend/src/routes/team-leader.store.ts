import { one, many, withTransaction, type Queryable } from '../db/query.js';
import { pool } from '../db/pool.js';
import { AuditWriter, type FieldSnapshot } from '../audit/index.js';
import { STOP_STATES } from '../status/index.js';

/**
 * A runner that executes `fn` inside a single database transaction, passing the
 * enlisted queryable. Production uses {@link withTransaction} (a real `pg`
 * transaction); tests inject a runner backed by a fake {@link Queryable} so the
 * store's guard/mutation/audit SQL is exercised without a live database.
 */
export type TransactionRunner = <T>(
  fn: (tx: Queryable) => Promise<T>,
) => Promise<T>;

/** The production transaction runner: a real `pg` transaction. */
const defaultTransactionRunner: TransactionRunner = (fn) =>
  withTransaction((client) => fn(client));

/**
 * Data-access layer for Team-Leader team management (design: "Administration"
 * — `GET/PATCH /api/team-leader/teams/{id}` — membership + details, leader-only;
 * member-removal guarded, R15, R20.3).
 *
 * ── Why an interface + a DB implementation ───────────────────────────────────
 * The route handlers (team-leader.routes.ts) depend on this narrow {@link
 * TeamLeaderStore} interface, never on `pg` directly, so they can be unit-tested
 * with an in-memory fake — matching the injectable style used by the team-admin
 * and data-point routes. The production {@link DbTeamLeaderStore} is the only
 * place that talks to Postgres, and it does so exclusively through the
 * parameterised data-access layer (`db/query.ts`): every value travels as a
 * bound placeholder, nothing is interpolated into SQL text.
 *
 * ── Guards and audit are the store's job, in one transaction ─────────────────
 * The member-removal guard (R15.4 / R20.3 — a support member with any non-closed
 * request associated with them under the team may not be removed) and the
 * column-level audit writes (R17) both run in the SAME transaction as the
 * mutations they describe, via {@link withTransaction} + the shared {@link
 * AuditWriter}. A guard failure aborts the whole transaction, so no partial
 * membership change or orphan audit row is ever committed.
 */

/** A team's details as returned to the team-leader screen (R15.2). */
export interface TeamDetails {
  readonly id: number;
  readonly title: string;
  readonly description: string | null;
  readonly teamLeaderId: number;
  readonly isClosed: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A single team member row (R15.3). */
export interface TeamMember {
  readonly userId: number;
  readonly username: string;
  readonly displayName: string;
}

/** A team's details plus its current membership (R15.2, R15.3). */
export interface TeamWithMembers {
  readonly team: TeamDetails;
  readonly members: TeamMember[];
}

/**
 * The changes a team leader may apply in one PATCH (R15.2, R15.3). Every field
 * is optional; only the supplied fields change.
 *
 *   - `title` / `description` update the team's details (R15.2). `description`
 *     may be explicitly set to `null` to clear it.
 *   - `addMemberIds` add users to the team (R15.3); already-members are ignored.
 *   - `removeMemberIds` remove users from the team (R15.3), guarded by
 *     non-closed requests (R15.4 / R20.3).
 */
export interface UpdateTeamLeaderInput {
  readonly title?: string;
  readonly description?: string | null;
  readonly addMemberIds?: readonly number[];
  readonly removeMemberIds?: readonly number[];
}

/** Raised when a team id does not exist. Mapped to 404 by the route layer. */
export class TeamNotFoundError extends Error {
  constructor(readonly teamId: number) {
    super(`Team ${teamId} not found`);
    this.name = 'TeamNotFoundError';
  }
}

/**
 * Raised by {@link TeamLeaderStore.update} when removing a member is blocked by
 * non-closed requests associated with that member under the team (R15.4 /
 * R20.3). The route layer maps this to the uniform `CONFLICT_OPEN_REQUESTS`
 * error envelope; keeping it a distinct error type keeps the store free of HTTP
 * concerns. `openRequestCount` is the count for the FIRST offending member.
 */
export class MemberRemovalConflictError extends Error {
  constructor(
    readonly teamId: number,
    readonly userId: number,
    readonly openRequestCount: number,
  ) {
    super(
      `Member ${userId} has ${openRequestCount} non-closed request(s) under team ${teamId}`,
    );
    this.name = 'MemberRemovalConflictError';
  }
}

/** The narrow contract the route handlers depend on. */
export interface TeamLeaderStore {
  /**
   * Fetch a team's details and current membership (R15.2, R15.3). Throws
   * {@link TeamNotFoundError} when the id is unknown.
   */
  getWithMembers(teamId: number): Promise<TeamWithMembers>;
  /**
   * Apply detail and/or membership changes in one transaction (R15.2, R15.3).
   * Removing a member is guarded by non-closed requests — throws {@link
   * MemberRemovalConflictError} when the member still has any non-closed request
   * under the team (R15.4 / R20.3). Throws {@link TeamNotFoundError} when the id
   * is unknown. Returns the updated team + membership.
   */
  update(
    teamId: number,
    input: UpdateTeamLeaderInput,
    actingUserId: number,
  ): Promise<TeamWithMembers>;
}

/** Shape of a `team` row as selected from Postgres (snake_case columns). */
interface TeamDbRow {
  id: string | number;
  title: string;
  description: string | null;
  team_leader_id: string | number;
  is_closed: boolean;
  created_at: Date | string;
  updated_at: Date | string;
}

/** Shape of a member row (team_member joined to app_user). */
interface MemberDbRow {
  user_id: string | number;
  username: string;
  first_name: string;
  surname: string;
}

/** Normalise a DB `team` row into the API {@link TeamDetails}. */
function toTeamDetails(row: TeamDbRow): TeamDetails {
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description,
    teamLeaderId: Number(row.team_leader_id),
    isClosed: row.is_closed,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

/** Normalise a DB member row into the API {@link TeamMember}. */
function toTeamMember(row: MemberDbRow): TeamMember {
  return {
    userId: Number(row.user_id),
    username: row.username,
    displayName: `${row.first_name} ${row.surname}`.trim(),
  };
}

/** ISO-8601 UTC string for a `timestamptz` value (design: dates as ISO-8601). */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** The audited-field snapshot for a team's details (column-level audit, R17). */
function teamDetailsSnapshot(row: TeamDetails): FieldSnapshot {
  return {
    title: row.title,
    description: row.description,
  };
}

/**
 * Postgres-backed {@link TeamLeaderStore}. All SQL is parameterised; mutations,
 * the removal guard, and their audit rows all share one transaction.
 */
export class DbTeamLeaderStore implements TeamLeaderStore {
  constructor(
    private readonly audit: AuditWriter = new AuditWriter(),
    private readonly runTransaction: TransactionRunner = defaultTransactionRunner,
    // The queryable used for non-transactional READS (getWithMembers). Defaults
    // to the shared pool in production; tests inject a fake so the read path is
    // exercised without a live database, matching the injectable store style.
    private readonly reader: Queryable = pool,
  ) {}

  async getWithMembers(teamId: number): Promise<TeamWithMembers> {
    const teamRow = await one<TeamDbRow>(
      `SELECT id, title, description, team_leader_id, is_closed,
              created_at, updated_at
         FROM team
        WHERE id = $1`,
      [teamId],
      this.reader,
    );
    if (!teamRow) {
      throw new TeamNotFoundError(teamId);
    }
    const members = await this.loadMembers(teamId, this.reader);
    return { team: toTeamDetails(teamRow), members };
  }

  async update(
    teamId: number,
    input: UpdateTeamLeaderInput,
    actingUserId: number,
  ): Promise<TeamWithMembers> {
    return this.runTransaction(async (tx) => {
      // Lock the team row for the duration so a concurrent request insert cannot
      // slip past the member-removal guard between the check and the delete.
      const current = await one<TeamDbRow>(
        `SELECT id, title, description, team_leader_id, is_closed,
                created_at, updated_at
           FROM team
          WHERE id = $1
          FOR UPDATE`,
        [teamId],
        tx,
      );
      if (!current) {
        throw new TeamNotFoundError(teamId);
      }
      const before = toTeamDetails(current);

      // ── Detail changes (R15.2) ───────────────────────────────────────────
      const nextTitle = input.title !== undefined ? input.title : before.title;
      const nextDescription =
        input.description !== undefined ? input.description : before.description;

      if (input.title !== undefined || input.description !== undefined) {
        const updated = await one<TeamDbRow>(
          `UPDATE team
              SET title       = $2,
                  description = $3,
                  updated_at  = now()
            WHERE id = $1
          RETURNING id, title, description, team_leader_id, is_closed,
                    created_at, updated_at`,
          [teamId, nextTitle, nextDescription],
          tx,
        );
        if (!updated) {
          throw new TeamNotFoundError(teamId);
        }
        const after = toTeamDetails(updated);
        // Column-level audit of exactly the detail fields that changed (R17).
        await this.audit.recordChanges(
          { entityType: 'team', entityId: teamId, changedById: actingUserId },
          teamDetailsSnapshot(before),
          teamDetailsSnapshot(after),
          tx,
        );
      }

      // ── Membership removals — guarded by open requests (R15.4 / R20.3) ────
      for (const userId of dedupe(input.removeMemberIds)) {
        const openCount = await countOpenRequestsForMember(teamId, userId, tx);
        if (openCount > 0) {
          throw new MemberRemovalConflictError(teamId, userId, openCount);
        }
        const removed = await one<{ user_id: string | number }>(
          `DELETE FROM team_member
            WHERE team_id = $1 AND user_id = $2
          RETURNING user_id`,
          [teamId, userId],
          tx,
        );
        if (removed) {
          // Audit the removal at the team_member level (member set → cleared).
          await this.audit.record(
            { entityType: 'team_member', entityId: teamId, changedById: actingUserId },
            [{ field: 'user_id', oldValue: userId, newValue: null }],
            tx,
          );
        }
      }

      // ── Membership additions (R15.3) ─────────────────────────────────────
      for (const userId of dedupe(input.addMemberIds)) {
        // ON CONFLICT DO NOTHING makes re-adding an existing member a no-op; the
        // RETURNING clause is empty in that case, so we only audit real inserts.
        const inserted = await one<{ user_id: string | number }>(
          `INSERT INTO team_member (team_id, user_id)
           VALUES ($1, $2)
           ON CONFLICT (team_id, user_id) DO NOTHING
           RETURNING user_id`,
          [teamId, userId],
          tx,
        );
        if (inserted) {
          await this.audit.record(
            { entityType: 'team_member', entityId: teamId, changedById: actingUserId },
            [{ field: 'user_id', oldValue: null, newValue: userId }],
            tx,
          );
        }
      }

      // Re-read details + membership for the response (reflects all changes).
      const finalTeam = await one<TeamDbRow>(
        `SELECT id, title, description, team_leader_id, is_closed,
                created_at, updated_at
           FROM team
          WHERE id = $1`,
        [teamId],
        tx,
      );
      if (!finalTeam) {
        throw new TeamNotFoundError(teamId);
      }
      const members = await this.loadMembers(teamId, tx);
      return { team: toTeamDetails(finalTeam), members };
    });
  }

  /** Load a team's members (joined to app_user), ordered by display name. */
  private async loadMembers(teamId: number, db?: Queryable): Promise<TeamMember[]> {
    const rows = await many<MemberDbRow>(
      `SELECT tm.user_id      AS user_id,
              au.username     AS username,
              au.first_name   AS first_name,
              au.surname      AS surname
         FROM team_member tm
         JOIN app_user au ON au.id = tm.user_id
        WHERE tm.team_id = $1
        ORDER BY au.surname ASC, au.first_name ASC, tm.user_id ASC`,
      [teamId],
      db,
    );
    return rows.map(toTeamMember);
  }
}

/** Deduplicate an optional id list, dropping falsy/absent entries. */
function dedupe(ids: readonly number[] | undefined): number[] {
  if (!ids || ids.length === 0) {
    return [];
  }
  return [...new Set(ids)];
}

/**
 * Count a member's non-closed requests under a team (R15.4 / R20.3). A request
 * is "associated with" a support member when they are the assigned member
 * (`request.assigned_member_id`). "Non-closed" is defined by the status state
 * machine's stop states (REJECTED/CANCELLED/COMPLETE): any request NOT in a
 * stop state blocks removal. The stop-state list is bound as a parameter array,
 * so the query text carries no interpolated values.
 */
async function countOpenRequestsForMember(
  teamId: number,
  userId: number,
  db: Queryable,
): Promise<number> {
  const row = await one<{ open_count: string | number }>(
    `SELECT COUNT(*) AS open_count
       FROM request
      WHERE team_id = $1
        AND assigned_member_id = $2
        AND status <> ALL($3::request_status[])`,
    [teamId, userId, [...STOP_STATES]],
    db,
  );
  return row ? Number(row.open_count) : 0;
}
