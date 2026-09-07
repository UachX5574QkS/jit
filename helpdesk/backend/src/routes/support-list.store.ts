import { many, type Queryable, type SqlParam } from '../db/query.js';
import { pool } from '../db/pool.js';

/**
 * Data-access layer for `GET /api/support/requests` — the Support-queue list
 * (design: "Support side" — `GET /api/support/requests?team=&scope=mine|team&
 * hideComplete=&showUnassigned=&q=`; R6).
 *
 * ── Why an interface + a DB implementation ───────────────────────────────────
 * The route handler (support-list.routes.ts) depends on this narrow
 * {@link SupportListStore} interface, never on `pg` directly, so it unit-tests
 * with an in-memory fake — matching the injectable style used by the
 * request-list, request-detail and request-create stores. The production
 * {@link DbSupportListStore} is the only place that talks to Postgres, and it
 * does so exclusively through the parameterised data-access layer
 * (`db/query.ts`): every value travels as a bound placeholder, nothing is
 * interpolated into SQL text (R22.2).
 *
 * ── The Team drop-down (R6.3) ────────────────────────────────────────────────
 * The Support screen is offered to support members — a support member is a user
 * who is a member of at least one team (`CurrentUser.teamsMemberOf` non-empty).
 * The "Team" drop-down lists the teams the current user belongs to plus an
 * "All" option meaning ALL the teams the user is in (R6.3). The authoritative
 * set is `CurrentUser.teamsMemberOf`, resolved by the route into
 * {@link SupportListViewer.teamIds}:
 *   • team = "all" (or omitted, the design default) → every team the user is in.
 *   • a specific team id → that ONE team, but only when the user is a member of
 *     it; a non-member team is a FORBIDDEN at the route (this store is only ever
 *     given the membership-checked set, so it trusts `teamIds`).
 * When the user is in NO teams the route returns an empty list for team scope
 * without consulting this store (nothing to query against).
 *
 * ── The two scopes (R6.4) ────────────────────────────────────────────────────
 *   • scope = "mine" (default) — the "My Queue" toggle: requests ASSIGNED TO the
 *     current user (`request.assigned_member_id = :userId`), further constrained
 *     to the selected team scope (a request always belongs to one team, so this
 *     is "requests assigned to me within the chosen team(s)").
 *   • scope = "team" — the "Team Queue" toggle: requests for the SELECTED team
 *     (or all the user's teams when "All"), regardless of who they are assigned
 *     to (`request.team_id = ANY(:teamIds)`).
 *
 * ── Show-unassigned (R6.6) ───────────────────────────────────────────────────
 * `showUnassigned` defaults to TRUE and controls whether requests with NO
 * assigned member are included. When false, only assigned requests are shown
 * (`assigned_member_id IS NOT NULL`). In "My Queue" the rows are — by
 * definition — assigned to the current user, so `showUnassigned` is naturally
 * moot there; the flag is honoured consistently regardless, so "Team Queue"
 * (where unassigned work lives) behaves as specified and "My Queue" is
 * unaffected either way.
 *
 * ── Hide-complete (R6.5) ─────────────────────────────────────────────────────
 * `hideComplete` defaults to TRUE. When true, requests in a STOP state —
 * COMPLETE, CANCELLED, or REJECTED (R6.5) — are excluded. When false, every
 * status is included.
 *
 * ── Search (R6.2) ────────────────────────────────────────────────────────────
 * `q` is a free-text search box that filters on ANY field within the scope of
 * the active toggle AND team drop-down (R6.2): it matches (case-insensitively)
 * against the task reference, Jira number, title, status, support-team title,
 * and the assigned team member's name. The term is bound as a single `%term%`
 * parameter used by every `ILIKE` — never interpolated into the SQL text — so
 * search is injection-safe.
 *
 * ── Columns (R6.7) ───────────────────────────────────────────────────────────
 * The Support screen presents the SAME request columns as the Requests screen
 * (R6.7). This store therefore returns the SAME row shape as the Requests-list
 * store, including `hasOpenTimer` (the "(Working On)" suffix input, R4.6) and
 * `updatedSinceLastSeen` computed for the CURRENT support user with the SAME
 * non-internal-change logic task 6.8 applies to the Requests screen
 * (R4.8/R7.5/R7.6). Estimated Effort (R4.7) is owned by task 6.7 and left
 * `null` here so the shape is stable, exactly as the Requests-list store does.
 */

/** Which requests the queue is scoped to within the team drop-down (R6.4). */
export type SupportListScope = 'mine' | 'team';

/** The query the caller (route) supplies, already normalised. */
export interface SupportListQuery {
  /** "mine" (assigned to me) or "team" (the selected team(s)). Default "mine". */
  readonly scope: SupportListScope;
  /** When true (default), exclude COMPLETE/CANCELLED/REJECTED requests (R6.5). */
  readonly hideComplete: boolean;
  /** When true (default), include requests with no assigned member (R6.6). */
  readonly showUnassigned: boolean;
  /** Optional free-text search term; matches any field in scope (R6.2). */
  readonly search: string | null;
}

/**
 * The viewer context the list needs. `teamIds` is the membership-checked team
 * scope resolved by the route from `CurrentUser.teamsMemberOf` and the `team`
 * query param (all → every team the user is in; a specific team → that one team
 * after the route has confirmed membership). Never empty when the store is
 * consulted — the route short-circuits an empty set to an empty list.
 */
export interface SupportListViewer {
  /** The current support user's `app_user.id`. */
  readonly userId: number;
  /** The team ids in scope (already checked against the user's memberships). */
  readonly teamIds: ReadonlyArray<number>;
}

/**
 * One row of the Support queue (camelCase, ISO dates) — the SAME columns the
 * Requests screen renders (R6.7). Identical in shape to the Requests-list row.
 */
export interface SupportListRow {
  readonly id: number;
  /** Task Number — the human-facing unique reference (R4.5). */
  readonly taskReference: string;
  /** Jira Number (R4.5); null when unset. */
  readonly jiraNumber: string | null;
  /** Title (R4.5). */
  readonly title: string;
  /** Date Raised — `request.created_at`, ISO-8601 (R4.5, R4.9). */
  readonly dateRaised: string;
  /** Status (R4.5). The "(Working On)" suffix is derived from `hasOpenTimer`. */
  readonly status: string;
  /** Support Team title (R4.5). */
  readonly teamId: number;
  readonly teamTitle: string;
  /** Assigned Team Member id + name (R4.5); null when unassigned. */
  readonly assignedMemberId: number | null;
  readonly assignedMemberName: string | null;
  /** Last Updated — `request.updated_at`, ISO-8601 (R4.5, R4.9). */
  readonly lastUpdated: string;
  /** Estimated Start Date, ISO-8601 or null (R4.5). */
  readonly estimatedStartDate: string | null;
  /** Actual Start Date, ISO-8601 or null (R4.5). */
  readonly actualStartDate: string | null;
  /**
   * Whether an open timer exists on this (non-closed) request — the input the
   * "(Working On)" status suffix is computed from (R4.6).
   */
  readonly hasOpenTimer: boolean;
  /**
   * Estimated Effort in minutes for the request's task type (R4.7). Left `null`
   * here — computed by task 6.7 — so the row shape is stable for that follow-up.
   */
  readonly estimatedEffortMinutes: number | null;
  /**
   * The "Updated" indicator for the CURRENT support user (R4.8, R7.5, R7.6):
   * true when the request has a non-internal change after the user's
   * `request_last_seen.last_seen_at` (or they have no last-seen row yet and the
   * request has any non-internal change). Internal-note changes never set it
   * (R7.5); all other changes do (R7.6).
   */
  readonly updatedSinceLastSeen: boolean;
}

/** The narrow contract the route handler depends on. */
export interface SupportListStore {
  /**
   * List the requests matching `query` for `viewer`. For scope "mine" the rows
   * are those assigned to the viewer within the team scope; for scope "team"
   * the rows are all requests for the selected team(s) (R6.4). Applies the
   * hide-complete (R6.5), show-unassigned (R6.6) and free-text search (R6.2)
   * filters, all constrained to the team drop-down scope (R6.3). Rows are
   * returned newest-first by last-updated.
   */
  list(query: SupportListQuery, viewer: SupportListViewer): Promise<SupportListRow[]>;
}

// ── DB row shape ──────────────────────────────────────────────────────────────

interface SupportListDbRow {
  id: string | number;
  task_reference: string;
  jira_number: string | null;
  title: string;
  created_at: Date | string;
  status: string;
  team_id: string | number;
  team_title: string;
  assigned_member_id: string | number | null;
  assigned_member_name: string | null;
  updated_at: Date | string;
  estimated_start_date: Date | string | null;
  actual_start_date: Date | string | null;
  has_open_timer: boolean;
  updated_since_last_seen: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** ISO-8601 UTC string for a `timestamptz` value (design: dates as ISO-8601). */
function toIso(value: Date | string | null): string | null {
  if (value == null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/** The stop (closed) states excluded by hide-complete (R6.5). */
const STOP_STATES = ['COMPLETE', 'CANCELLED', 'REJECTED'] as const;

function toRow(row: SupportListDbRow): SupportListRow {
  return {
    id: Number(row.id),
    taskReference: row.task_reference,
    jiraNumber: row.jira_number,
    title: row.title,
    dateRaised: toIso(row.created_at) as string,
    status: row.status,
    teamId: Number(row.team_id),
    teamTitle: row.team_title,
    assignedMemberId:
      row.assigned_member_id == null ? null : Number(row.assigned_member_id),
    assignedMemberName: row.assigned_member_name,
    lastUpdated: toIso(row.updated_at) as string,
    estimatedStartDate: toIso(row.estimated_start_date),
    actualStartDate: toIso(row.actual_start_date),
    hasOpenTimer: row.has_open_timer === true,
    // Owned by task 6.7; left null so the row shape is stable.
    estimatedEffortMinutes: null,
    // The "Updated" indicator for the viewing support user (R4.8, R7.5, R7.6).
    updatedSinceLastSeen: row.updated_since_last_seen === true,
  };
}

/**
 * Postgres-backed {@link SupportListStore}. All SQL is parameterised. The team
 * scope, the current user id (for the "My Queue" filter and the "Updated"
 * join), the stop-state list and the `%term%` search term all travel as bound
 * parameters — nothing is interpolated into the SQL text (R22.2).
 */
export class DbSupportListStore implements SupportListStore {
  constructor(private readonly db: Queryable = pool) {}

  async list(
    query: SupportListQuery,
    viewer: SupportListViewer,
  ): Promise<SupportListRow[]> {
    // The store is only consulted with a non-empty team scope (the route
    // short-circuits an empty set to an empty list). Defensively, an empty set
    // still means "no teams to look in" → no rows, never an `= ANY([])`.
    if (viewer.teamIds.length === 0) {
      return [];
    }

    // $1 is the team scope (the team drop-down set, R6.3); every query is bound
    // to requests within the user's selected team(s). $2 is the CURRENT user's
    // id, used by BOTH the "My Queue" filter (scope=mine) and the "Updated"
    // computation's per-user last-seen join, so the conditional
    // hide-complete/show-unassigned/search params keep predictable indices from
    // $3 onward.
    const params: SqlParam[] = [[...viewer.teamIds], viewer.userId];
    const conditions: string[] = ['r.team_id = ANY($1)'];

    // Scope (R6.4):
    //   • "mine"  → "My Queue": requests assigned to the current user, within
    //     the team scope already constrained above.
    //   • "team"  → "Team Queue": all requests for the selected team(s); no
    //     assignment constraint here (show-unassigned governs that below).
    if (query.scope === 'mine') {
      conditions.push('r.assigned_member_id = $2');
    }

    // Hide-complete (R6.5): exclude the stop states when the flag is on. The
    // status list is a code-controlled constant, bound as an array parameter.
    if (query.hideComplete) {
      params.push([...STOP_STATES]);
      conditions.push(`r.status <> ALL($${params.length}::request_status[])`);
    }

    // Show-unassigned (R6.6): when OFF, drop requests with no assigned member.
    // Honoured consistently for both toggles; naturally moot for "My Queue"
    // (those rows are assigned to the current user) but applied regardless so
    // "Team Queue" behaves exactly as specified.
    if (!query.showUnassigned) {
      conditions.push('r.assigned_member_id IS NOT NULL');
    }

    // Search (R6.2): one bound `%term%` parameter, matched case-insensitively
    // across every field in scope. No value is interpolated into the SQL text.
    if (query.search) {
      params.push(`%${query.search}%`);
      const p = `$${params.length}`;
      conditions.push(
        `(
           r.task_reference ILIKE ${p}
           OR r.jira_number ILIKE ${p}
           OR r.title ILIKE ${p}
           OR r.status::text ILIKE ${p}
           OR tm.title ILIKE ${p}
           OR (am.first_name || ' ' || am.surname) ILIKE ${p}
         )`,
      );
    }

    const where = conditions.join('\n            AND ');

    // The assigned member's display name is composed the SAME way as
    // CurrentUser.displayName ("first surname"). An open timer against a
    // non-closed request drives the "(Working On)" suffix (R4.6); it is exposed
    // as a boolean the frontend appends, computed via EXISTS against
    // active_timer excluding stop-state requests. The "Updated" indicator
    // ($2 = the current support user) uses the SAME non-internal-change logic
    // as the Requests screen (task 6.8): the newest audit_entry change about
    // the request itself or its EXTERNAL notes (internal-note entries excluded,
    // R7.5), compared to the user's own last_seen row (R4.8/R7.6).
    const rows = await many<SupportListDbRow>(
      `SELECT r.id                   AS id,
              r.task_reference        AS task_reference,
              r.jira_number           AS jira_number,
              r.title                 AS title,
              r.created_at            AS created_at,
              r.status::text          AS status,
              r.team_id               AS team_id,
              tm.title                AS team_title,
              r.assigned_member_id    AS assigned_member_id,
              CASE
                WHEN am.id IS NULL THEN NULL
                ELSE am.first_name || ' ' || am.surname
              END                     AS assigned_member_name,
              r.updated_at            AS updated_at,
              r.estimated_start_date  AS estimated_start_date,
              r.actual_start_date     AS actual_start_date,
              (
                r.status <> ALL(ARRAY['COMPLETE','REJECTED','CANCELLED']::request_status[])
                AND EXISTS (
                  SELECT 1 FROM active_timer at WHERE at.request_id = r.id
                )
              )                       AS has_open_timer,
              -- The "Updated" indicator for the viewing support user ($2) —
              -- R4.8/R7.5/R7.6, identical to the Requests-screen computation.
              (
                lnc.latest_change IS NOT NULL
                AND (
                  rls.last_seen_at IS NULL
                  OR lnc.latest_change > rls.last_seen_at
                )
              )                       AS updated_since_last_seen
         FROM request r
         JOIN team tm            ON tm.id = r.team_id
         LEFT JOIN app_user am   ON am.id = r.assigned_member_id
         LEFT JOIN request_last_seen rls
                ON rls.request_id = r.id
               AND rls.user_id = $2
         LEFT JOIN LATERAL (
                SELECT MAX(ae.changed_at) AS latest_change
                  FROM audit_entry ae
                 WHERE (ae.entity_type = 'request' AND ae.entity_id = r.id)
                    OR (ae.entity_type = 'request_note'
                        AND ae.entity_id IN (
                          SELECT rn.id
                            FROM request_note rn
                           WHERE rn.request_id = r.id
                             AND rn.is_internal = false
                        ))
              ) lnc ON true
        WHERE ${where}
        ORDER BY r.updated_at DESC, r.id DESC`,
      params,
      this.db,
    );

    return rows.map(toRow);
  }
}
