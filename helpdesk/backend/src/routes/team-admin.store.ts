import { one, many, withTransaction, type Queryable } from '../db/query.js';
import { AuditWriter, type FieldSnapshot } from '../audit/index.js';
import { STOP_STATES } from '../status/index.js';

/**
 * A runner that executes `fn` inside a single database transaction, passing the
 * enlisted queryable. Production uses {@link withTransaction} (a real `pg`
 * transaction); tests inject a runner backed by a fake {@link Queryable} so the
 * store's guard/audit SQL is exercised without a live database.
 */
export type TransactionRunner = <T>(
  fn: (tx: Queryable) => Promise<T>,
) => Promise<T>;

/** The production transaction runner: a real `pg` transaction. */
const defaultTransactionRunner: TransactionRunner = (fn) =>
  withTransaction((client) => fn(client));

/**
 * Data-access layer for Tool-Administrator team reference data (design:
 * "Administration" — `POST/GET/PATCH /api/admin/teams`, R13, R20.2).
 *
 * ── Why an interface + a DB implementation ───────────────────────────────────
 * The route handlers (team-admin.routes.ts) depend on this narrow {@link
 * TeamAdminStore} interface, never on `pg` directly, so they can be unit-tested
 * with an in-memory fake — matching the injectable style used by the auth
 * routes. The production {@link DbTeamAdminStore} is the only place that talks
 * to Postgres, and it does so exclusively through the parameterised data-access
 * layer (`db/query.ts`): every value travels as a bound placeholder, nothing is
 * interpolated into SQL text.
 *
 * ── Guards and audit are the store's job, in one transaction ─────────────────
 * The reference-data lifecycle guard (R20.2 — a team with any non-closed
 * request may not be closed) and the column-level audit write (R17) both run in
 * the SAME transaction as the mutation they describe, via {@link
 * withTransaction} + the shared {@link AuditWriter}. A guard failure aborts the
 * whole transaction, so no partial change or orphan audit row is ever
 * committed.
 */

/** A team row as returned to the admin Teams table (R13.3). */
export interface TeamRow {
  readonly id: number;
  readonly title: string;
  readonly description: string | null;
  readonly teamLeaderId: number;
  readonly isClosed: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Fields accepted when creating a team (R13.2). */
export interface CreateTeamInput {
  readonly title: string;
  readonly description: string | null;
  readonly teamLeaderId: number;
}

/**
 * Fields accepted when updating a team (R13.3). Every field is optional; only
 * the supplied fields change. `teamLeaderId` re-assigns the leader/owner;
 * `isClosed: true` closes the team (guarded by open requests, R20.2).
 */
export interface UpdateTeamInput {
  readonly teamLeaderId?: number;
  readonly isClosed?: boolean;
}

/**
 * Raised by {@link TeamAdminStore.update} when a close is blocked by non-closed
 * requests (R20.2). The route layer maps this to the uniform
 * `CONFLICT_OPEN_REQUESTS` error envelope; keeping it a distinct error type
 * keeps the store free of HTTP concerns.
 */
export class OpenRequestsConflictError extends Error {
  constructor(
    readonly teamId: number,
    readonly openRequestCount: number,
  ) {
    super(`Team ${teamId} has ${openRequestCount} non-closed request(s)`);
    this.name = 'OpenRequestsConflictError';
  }
}

/** Raised when a team id does not exist. Mapped to 404 by the route layer. */
export class TeamNotFoundError extends Error {
  constructor(readonly teamId: number) {
    super(`Team ${teamId} not found`);
    this.name = 'TeamNotFoundError';
  }
}

/** The narrow contract the route handlers depend on. */
export interface TeamAdminStore {
  /** Create a team and assign its leader; returns the created row (R13.2). */
  create(input: CreateTeamInput, actingUserId: number): Promise<TeamRow>;
  /** List all teams (open and closed) for the admin table (R13.3). */
  list(): Promise<TeamRow[]>;
  /**
   * Update a team's leader and/or closed flag (R13.3). Closing is guarded by
   * open requests (R20.2) — throws {@link OpenRequestsConflictError} when the
   * team still has non-closed requests. Throws {@link TeamNotFoundError} when
   * the id is unknown. Returns the updated row.
   */
  update(
    teamId: number,
    input: UpdateTeamInput,
    actingUserId: number,
  ): Promise<TeamRow>;
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

/** Normalise a DB `team` row into the API {@link TeamRow} (numbers, ISO dates). */
function toTeamRow(row: TeamDbRow): TeamRow {
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

/** ISO-8601 UTC string for a `timestamptz` value (design: dates as ISO-8601). */
function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** The audited-field snapshot for a team row (column-level audit, R17). */
function teamSnapshot(row: TeamRow): FieldSnapshot {
  return {
    title: row.title,
    description: row.description,
    team_leader_id: row.teamLeaderId,
    is_closed: row.isClosed,
  };
}

/**
 * Postgres-backed {@link TeamAdminStore}. All SQL is parameterised; mutations
 * and their audit rows share one transaction.
 */
export class DbTeamAdminStore implements TeamAdminStore {
  constructor(
    private readonly audit: AuditWriter = new AuditWriter(),
    private readonly runTransaction: TransactionRunner = defaultTransactionRunner,
  ) {}

  async create(input: CreateTeamInput, actingUserId: number): Promise<TeamRow> {
    return this.runTransaction(async (tx) => {
      const created = await one<TeamDbRow>(
        `INSERT INTO team (title, description, team_leader_id)
         VALUES ($1, $2, $3)
         RETURNING id, title, description, team_leader_id, is_closed,
                   created_at, updated_at`,
        [input.title, input.description, input.teamLeaderId],
        tx,
      );
      // one() with RETURNING always yields the inserted row; guard for types.
      if (!created) {
        throw new Error('INSERT ... RETURNING produced no row');
      }
      const row = toTeamRow(created);
      // Column-level audit: record the created team's fields as first-set
      // (old → NULL) in the SAME transaction as the INSERT (R17.1, R17.2).
      await this.audit.recordChanges(
        { entityType: 'team', entityId: row.id, changedById: actingUserId },
        {},
        teamSnapshot(row),
        tx,
      );
      return row;
    });
  }

  async list(): Promise<TeamRow[]> {
    const rows = await many<TeamDbRow>(
      `SELECT id, title, description, team_leader_id, is_closed,
              created_at, updated_at
         FROM team
        ORDER BY title ASC, id ASC`,
    );
    return rows.map(toTeamRow);
  }

  async update(
    teamId: number,
    input: UpdateTeamInput,
    actingUserId: number,
  ): Promise<TeamRow> {
    return this.runTransaction(async (tx) => {
      // Lock the row for the duration so a concurrent request insert cannot
      // slip past the close guard between the check and the update.
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
      const before = toTeamRow(current);

      // R20.2: a team may not be closed while it has any non-closed request.
      // Only enforced on a transition INTO closed; re-closing an already-closed
      // team, or leaving the flag alone, needs no check.
      if (input.isClosed === true && !before.isClosed) {
        const openCount = await countOpenRequests(teamId, tx);
        if (openCount > 0) {
          throw new OpenRequestsConflictError(teamId, openCount);
        }
      }

      const nextLeaderId =
        input.teamLeaderId !== undefined ? input.teamLeaderId : before.teamLeaderId;
      const nextClosed =
        input.isClosed !== undefined ? input.isClosed : before.isClosed;

      const updated = await one<TeamDbRow>(
        `UPDATE team
            SET team_leader_id = $2,
                is_closed      = $3,
                updated_at     = now()
          WHERE id = $1
        RETURNING id, title, description, team_leader_id, is_closed,
                  created_at, updated_at`,
        [teamId, nextLeaderId, nextClosed],
        tx,
      );
      if (!updated) {
        throw new TeamNotFoundError(teamId);
      }
      const after = toTeamRow(updated);

      // Column-level audit of exactly the fields that changed (R17.1, R17.2),
      // in the SAME transaction as the UPDATE.
      await this.audit.recordChanges(
        { entityType: 'team', entityId: teamId, changedById: actingUserId },
        teamSnapshot(before),
        teamSnapshot(after),
        tx,
      );
      return after;
    });
  }
}

/**
 * Count a team's non-closed requests (R20.2). "Non-closed" is defined by the
 * status state machine's stop states (REJECTED/CANCELLED/COMPLETE): any request
 * NOT in a stop state blocks closing the team. The stop-state list is bound as
 * a parameter array, so the query text carries no interpolated values.
 */
async function countOpenRequests(teamId: number, db: Queryable): Promise<number> {
  const row = await one<{ open_count: string | number }>(
    `SELECT COUNT(*) AS open_count
       FROM request
      WHERE team_id = $1
        AND status <> ALL($2::request_status[])`,
    [teamId, [...STOP_STATES]],
    db,
  );
  return row ? Number(row.open_count) : 0;
}
