/**
 * The frontend mirror of the request status state machine (design: "Status enum
 * & state machine", R9). This is the client-side counterpart of
 * `backend/src/status/status.ts` — kept byte-for-byte aligned with the rules
 * there so the Support detail view can present ONLY the legal next statuses for
 * a request's current status (R9.4–9.7).
 *
 * ── Server is the authority ──────────────────────────────────────────────────
 * The backend re-validates every status change and rejects an illegal move with
 * `INVALID_TRANSITION` (R9.7); this module is UX, not the authority. Surfacing
 * only legal transitions keeps the UI honest, but the support screen still
 * handles an `INVALID_TRANSITION` from the PATCH gracefully in case the request
 * moved underneath the viewer (e.g. a timer auto-transition or a concurrent
 * support edit).
 *
 * ── The rules (R9) ───────────────────────────────────────────────────────────
 *   NEW      → TRIAGE
 *   TRIAGE   → ACCEPTED | REJECTED
 *   ACCEPTED → ASSIGNED
 *   ASSIGNED → ACTIVE | PAUSED | BLOCKED
 *   PAUSED   → ACTIVE
 *   BLOCKED  → ACTIVE
 *   ACTIVE   → COMPLETE | PAUSED | BLOCKED
 *   (any non-stop state) → CANCELLED
 *
 * COMPLETE is reachable ONLY from ACTIVE (R9.5); CANCELLED from any non-stop
 * state (R9.6); anything else is rejected (R9.7). The constrained raiser
 * CANCELLED → NEW reopen edge is a user-side path (R5.6), not a support
 * transition, so it is intentionally absent here.
 */

/** The ten request lifecycle statuses (R9.1), matching the backend `STATUSES`. */
export const STATUSES = [
  'NEW',
  'TRIAGE',
  'ACCEPTED',
  'ASSIGNED',
  'ACTIVE',
  'PAUSED',
  'BLOCKED',
  'REJECTED',
  'CANCELLED',
  'COMPLETE',
] as const;

/** A request status. Union of the ten values in {@link STATUSES}. */
export type Status = (typeof STATUSES)[number];

/** The stop (closed / terminal) states — REJECTED/CANCELLED/COMPLETE (R9.3). */
export const STOP_STATES: readonly Status[] = ['REJECTED', 'CANCELLED', 'COMPLETE'];

const STOP_STATE_SET: ReadonlySet<Status> = new Set(STOP_STATES);

const STATUS_SET: ReadonlySet<string> = new Set(STATUSES);

/** True iff `value` is one of the ten known statuses. */
export function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && STATUS_SET.has(value);
}

/** True iff `status` is a stop (closed) state (R9.3). */
export function isStopState(status: Status): boolean {
  return STOP_STATE_SET.has(status);
}

/**
 * The base general-machine transitions, keyed by source status (R9.4–9.5).
 * CANCELLED is added to every non-stop state's target set below (R9.6) rather
 * than repeated by hand.
 */
const BASE_TRANSITIONS: Readonly<Record<Status, readonly Status[]>> = {
  NEW: ['TRIAGE'],
  TRIAGE: ['ACCEPTED', 'REJECTED'],
  ACCEPTED: ['ASSIGNED'],
  ASSIGNED: ['ACTIVE', 'PAUSED', 'BLOCKED'],
  PAUSED: ['ACTIVE'],
  BLOCKED: ['ACTIVE'],
  ACTIVE: ['COMPLETE', 'PAUSED', 'BLOCKED'],
  REJECTED: [],
  CANCELLED: [],
  COMPLETE: [],
};

/**
 * The effective transition table: the base rules plus the implicit
 * "→ CANCELLED from any non-stop state" edge (R9.6). Built once at module load.
 */
const TRANSITIONS: Readonly<Record<Status, ReadonlySet<Status>>> = (() => {
  const table = {} as Record<Status, Set<Status>>;
  for (const status of STATUSES) {
    const targets = new Set<Status>(BASE_TRANSITIONS[status]);
    if (!STOP_STATE_SET.has(status)) {
      targets.add('CANCELLED');
    }
    table[status] = targets;
  }
  return table;
})();

/** Whether `from` → `to` is a permitted support transition (R9.4–9.7). */
export function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from].has(to);
}

/**
 * The set of statuses reachable from `from` in one general-machine step
 * (excludes the constrained raiser reopen edge). Drives the Support screen's
 * status control, which offers only the valid next statuses (R9). Returns a
 * fresh array in {@link STATUSES} order.
 */
export function allowedTargets(from: Status): Status[] {
  return STATUSES.filter((to) => TRANSITIONS[from].has(to));
}
