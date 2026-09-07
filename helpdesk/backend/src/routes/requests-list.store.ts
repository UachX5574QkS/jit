import { many, type Queryable, type SqlParam } from '../db/query.js';
import { pool } from '../db/pool.js';
import {
  resolveDownwardHierarchy,
  DbManagerGraphLoader,
  type ManagerGraphLoader,
} from '../hierarchy/index.js';

/**
 * Data-access layer for `GET /api/requests` — the user-side Requests list
 * (design: "Requests (user side)" — `GET /api/requests?scope=mine|team&
 * hideComplete=&q=` — list for Requests screen, hierarchy-scoped;
 * R4.1–4.4, R4.9, R19).
 *
 * ── Why an interface + a DB implementation ───────────────────────────────────
 * The route handler (requests-list.routes.ts) depends on this narrow
 * {@link RequestListStore} interface, never on `pg` directly, so it unit-tests
 * with an in-memory fake — matching the injectable style used by the
 * request-detail, request-create and user-mutations stores. The production
 * {@link DbRequestListStore} is the only place that talks to Postgres, and it
 * does so exclusively through the parameterised data-access layer
 * (`db/query.ts`): every value travels as a bound placeholder, nothing is
 * interpolated into SQL text (R22.2).
 *
 * ── The two scopes (R4.3, R19) ───────────────────────────────────────────────
 *   • scope = "mine" (default) — requests RAISED BY the current user
 *     (`request.raised_by_id = :userId`). This is the "My Requests" toggle.
 *   • scope = "team" ("My Team") — requests raised by anyone within the current
 *     user's DOWNWARD management hierarchy (R4.3). The hierarchy is resolved
 *     through the SAME manager-hierarchy resolver as Team Statistics (task 3.6,
 *     R19): it applies the area-manager cutoff (R19.2) and guards against cycles
 *     (R19.4). The list is then filtered to `raised_by_id IN (<hierarchy set>)`.
 *     When the hierarchy is empty (a leaf manager with no reports) the list is
 *     empty — nothing is raised by "no-one".
 *
 * The Requests screen is offered to a user only when they have raised a request
 * OR requests exist within their hierarchy (R4.1); that visibility gate is a
 * frontend concern (task 11.1) — this endpoint simply returns the matching rows
 * for whichever scope is asked for, and is available to any authenticated user
 * (R4.1 by construction: it never leaks a request outside the caller's scope).
 *
 * ── Hide-complete (R4.4) ─────────────────────────────────────────────────────
 * `hideComplete` defaults to TRUE. When true, requests in a STOP state —
 * COMPLETE, REJECTED, or CANCELLED (R4.4) — are excluded. When false, every
 * status is included.
 *
 * ── Search (R4.2) ────────────────────────────────────────────────────────────
 * `q` is a free-text search box that filters on ANY field within the active
 * scope (R4.2): it matches (case-insensitively) against the task reference,
 * Jira number, title, status, support-team title, and the assigned team
 * member's name. The term is bound as a single `%term%` parameter used by every
 * `ILIKE` — never interpolated into the SQL text — so search is injection-safe.
 *
 * ── Columns (R4.5, R4.9) ─────────────────────────────────────────────────────
 * Each row carries the columns the Requests screen needs: Task Number
 * (reference), Jira, Title, Date Raised (created_at), Status, Support Team,
 * Assigned Team Member, Last Updated (updated_at), Estimated Start Date, and
 * Actual Start Date. All timestamps are emitted as ISO-8601 strings and every
 * field is camelCase (R4.9 — the browser renders them in the viewer's local
 * time). `hasOpenTimer` surfaces whether a non-closed request has an open timer,
 * the input the "(Working On)" status suffix is computed from (R4.6).
 *
 * Estimated Effort (R4.7) is deliberately NOT computed here — it is owned by
 * task 6.7. The row exposes `estimatedEffortMinutes` as a nullable hook left
 * `null` by this task so the shape is stable for that follow-up.
 *
 * ── The "Updated" indicator (R4.8, R7.5, R7.6) ───────────────────────────────
 * Each row carries `updatedSinceLastSeen` for the CURRENT viewer: true when the
 * request has had a NON-INTERNAL change AFTER that viewer last opened it (R4.8).
 * The design ties this flag directly to "a non-internal change after this
 * user's `last_seen_at`", so the signal is derived from the authoritative audit
 * trail rather than trusting a single denormalised column:
 *
 *   • The "latest non-internal change" for a request is the newest
 *     `audit_entry.changed_at` among (a) entries about the request itself
 *     (`entity_type = 'request'`) and (b) entries about the request's EXTERNAL
 *     notes (`entity_type = 'request_note'` for a note with
 *     `is_internal = false`). Audit entries that pertain to INTERNAL notes are
 *     excluded, so an internal-note change never flags the user's Requests view
 *     (R7.5); every other kind of change does (R7.6). This mirrors exactly the
 *     internal-note exclusion the request-detail store applies to the audit
 *     trail it returns, so the two agree on what a "non-internal change" is.
 *
 *   • The viewer's `request_last_seen.last_seen_at` for the request is joined in
 *     (per-user, keyed by the bound viewer id). The flag is
 *     `latest_non_internal_change > last_seen_at`.
 *
 *   • No last-seen row yet: the viewer has never opened the request. A request
 *     with any non-internal change (every request has one — creation itself is
 *     audited as `entity_type = 'request'`) is therefore "Updated" for them —
 *     the intended behaviour for a request that appears in their scope but which
 *     they have not read. The raiser's own freshly-created request does NOT
 *     falsely flag because task 6.3 sets their `last_seen` on create.
 *
 * Note on the alternative signal: the user-mutation stores bump
 * `request.updated_at` ONLY on non-internal changes (field/Jira updates, notes,
 * status transitions) and internal notes (task 7.3) will NOT bump it, so
 * `updated_at > last_seen_at` would give the same answer while that invariant
 * holds. We deliberately compute from `audit_entry` (excluding internal-note
 * entries) instead, so the determination stays correct by construction even if
 * a future path touches `updated_at`, and so "non-internal" is defined the same
 * way here as in the audit trail the detail view shows.
 */

/** Which requests the list is scoped to (R4.3). */
export type RequestListScope = 'mine' | 'team';

/** The query the caller (route) supplies, already normalised. */
export interface RequestListQuery {
  /** "mine" (raised by the user) or "team" (raised within their hierarchy). */
  readonly scope: RequestListScope;
  /** When true (default), exclude COMPLETE/REJECTED/CANCELLED requests (R4.4). */
  readonly hideComplete: boolean;
  /** Optional free-text search term; matches any field in scope (R4.2). */
  readonly search: string | null;
}

/** The viewer context the list needs (raiser scope, hierarchy root). */
export interface ListViewer {
  /** The current user's `app_user.id`. */
  readonly userId: number;
}

/**
 * One row of the Requests list (camelCase, ISO dates) — the columns the
 * Requests screen renders (R4.5, R4.9).
 */
export interface RequestListRow {
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
   * The "Updated" indicator for the CURRENT viewer (R4.8, R7.5, R7.6): true when
   * the request has a non-internal change after the viewer's
   * `request_last_seen.last_seen_at` (or the viewer has no last-seen row yet and
   * the request has any non-internal change). Internal-note changes never set it
   * (R7.5); all other changes do (R7.6).
   */
  readonly updatedSinceLastSeen: boolean;
}

/** The narrow contract the route handler depends on. */
export interface RequestListStore {
  /**
   * List the requests matching `query` for `viewer`. For scope "mine" the rows
   * are those the viewer raised; for scope "team" the rows are those raised by
   * anyone in the viewer's downward management hierarchy (R4.3, R19). Applies
   * the hide-complete filter (R4.4) and the free-text search (R4.2). Rows are
   * returned newest-first by last-updated. Available to any authenticated user
   * (R4.1); never returns a request outside the requested scope.
   */
  list(query: RequestListQuery, viewer: ListViewer): Promise<RequestListRow[]>;
}

// ── DB row shape ──────────────────────────────────────────────────────────────

interface RequestListDbRow {
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

/** The stop (closed) states excluded by hide-complete (R4.4). */
const STOP_STATES = ['COMPLETE', 'REJECTED', 'CANCELLED'] as const;

function toRow(row: RequestListDbRow): RequestListRow {
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
    // The "Updated" indicator for the viewing user (R4.8, R7.5, R7.6).
    updatedSinceLastSeen: row.updated_since_last_seen === true,
  };
}

/**
 * Postgres-backed {@link RequestListStore}. All SQL is parameterised. For scope
 * "team" the raiser set is resolved through the injected
 * {@link ManagerGraphLoader} + the pure {@link resolveDownwardHierarchy}, so the
 * area-manager cutoff and cycle guard (R19) are reused rather than reimplemented.
 */
export class DbRequestListStore implements RequestListStore {
  constructor(
    private readonly db: Queryable = pool,
    private readonly graphLoader: ManagerGraphLoader = new DbManagerGraphLoader(),
  ) {}

  async list(query: RequestListQuery, viewer: ListViewer): Promise<RequestListRow[]> {
    // Resolve the raiser set for the active scope (R4.3, R19).
    //   • "mine": exactly the current user.
    //   • "team": everyone in the current user's downward hierarchy (NOT the
    //     user themselves — "My Team" is the people under them). An empty set
    //     short-circuits to no rows, so we never issue an `IN ()`.
    let raiserIds: number[];
    if (query.scope === 'team') {
      const graph = await this.graphLoader.load();
      raiserIds = [...resolveDownwardHierarchy(viewer.userId, graph)];
      if (raiserIds.length === 0) {
        return [];
      }
    } else {
      raiserIds = [viewer.userId];
    }

    // Bind the raiser set as a single array parameter and match with `= ANY($1)`
    // — the whole set travels as one bound value, never interpolated (R22.2).
    // $2 is the CURRENT viewer's id, used by the "Updated" computation to join
    // their own `request_last_seen` row; it is fixed early so the conditional
    // hide-complete/search params keep predictable indices from $3 onward.
    const params: SqlParam[] = [raiserIds, viewer.userId];
    const conditions: string[] = ['r.raised_by_id = ANY($1)'];

    // Hide-complete (R4.4): exclude the stop states when the flag is on. The
    // status list is a code-controlled constant, bound as an array parameter.
    if (query.hideComplete) {
      params.push([...STOP_STATES]);
      conditions.push(`r.status <> ALL($${params.length}::request_status[])`);
    }

    // Search (R4.2): one bound `%term%` parameter, matched case-insensitively
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
    // active_timer excluding stop-state requests.
    const rows = await many<RequestListDbRow>(
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
              -- The "Updated" indicator for the viewing user ($2) — R4.8/R7.5/R7.6.
              -- lnc.latest_change is the newest NON-INTERNAL change timestamp:
              -- audit entries about the request itself, plus audit entries about
              -- its EXTERNAL notes (is_internal = false). Internal-note entries
              -- are excluded, so an internal-note change never flags the user's
              -- Requests view (R7.5); every other change does (R7.6). rls is the
              -- viewer's own last-seen row. The flag is: a non-internal change
              -- exists AND it is newer than when this viewer last opened the
              -- request, or the viewer has never opened it (no last-seen row).
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
