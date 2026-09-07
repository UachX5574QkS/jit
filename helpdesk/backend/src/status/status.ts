import { ApiError } from '../middleware/errors.js';

/**
 * The central request status state machine (design: "Status enum & state
 * machine", R9).
 *
 * ── Single source of truth for transitions ──────────────────────────────────
 * Every status change in the system — support-side updates (R7.1, task 7.2) and
 * the raiser Cancel/Reopen path (R5.5–5.7, task 6.5) — is validated HERE. The
 * schema owns the set of statuses (the `request_status` enum, migration 0005)
 * and which are terminal (`request_status_stop_state`, migration 0008); this
 * module owns the RULES for moving between them (R9.4–9.7). Callers never
 * hard-code allowed pairs; they ask {@link canTransition} / {@link assertTransition}.
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
 *   CANCELLED → NEW   (constrained raiser "Reopen" only — see below)
 *
 * COMPLETE is reachable ONLY from ACTIVE (R9.5). CANCELLED is reachable from any
 * non-stop state (R9.6). Anything not listed is rejected (R9.7).
 *
 * ── Two distinct paths ───────────────────────────────────────────────────────
 * The raiser Cancel/Reopen path is deliberately separate from the general
 * support state machine (R5.5–5.7):
 *   • Cancel (→ CANCELLED) is part of the general machine — allowed from any
 *     non-stop state, by support or raiser.
 *   • Reopen (CANCELLED → NEW) is a CONSTRAINED path that only the raiser who
 *     cancelled the request may take. Because that identity/authorisation check
 *     is the caller's responsibility (task 6.5), the general {@link canTransition}
 *     rejects CANCELLED → NEW by default; callers opt into it via the
 *     `allowReopen` flag or, more readably, {@link canReopen} /
 *     {@link assertReopen}. This keeps the reopen path expressible without
 *     letting the general machine leak out of a stop state.
 *
 * ── SQL/error shape ──────────────────────────────────────────────────────────
 * Pure and side-effect free (unit-tested without a database). The guard variant
 * throws the shared {@link ApiError} with code `INVALID_TRANSITION` (R9.7); the
 * full error-code catalogue is task 3.8, so this reuses the existing envelope
 * rather than inventing a new one.
 */

/** The ten request lifecycle statuses (R9.1), matching the `request_status` enum. */
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

/** The stop (closed / terminal) states (R9.3). */
export const STOP_STATES: readonly Status[] = ['REJECTED', 'CANCELLED', 'COMPLETE'];

const STOP_STATE_SET: ReadonlySet<Status> = new Set(STOP_STATES);

/**
 * The allowed general-machine transitions, keyed by source status (R9.4–9.5).
 *
 * CANCELLED is added to every non-stop state's target set programmatically
 * below (R9.6, "cancel from any non-stop state") rather than repeated by hand.
 * CANCELLED → NEW (reopen) is intentionally absent here: it is a constrained
 * raiser path, not a general transition (see {@link canReopen}).
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
    // R9.6: a non-stop state may always transition to CANCELLED.
    if (!STOP_STATE_SET.has(status)) {
      targets.add('CANCELLED');
    }
    table[status] = targets;
  }
  return table;
})();

/** True iff `value` is one of the ten known statuses. */
export function isStatus(value: unknown): value is Status {
  return (
    typeof value === 'string' && (STATUSES as readonly string[]).includes(value)
  );
}

/** True iff `status` is a stop (closed / terminal) state — REJECTED/CANCELLED/COMPLETE (R9.3). */
export function isStopState(status: Status): boolean {
  return STOP_STATE_SET.has(status);
}

/** Options controlling which constrained paths {@link canTransition} permits. */
export interface TransitionOptions {
  /**
   * Opt into the constrained raiser "Reopen" edge CANCELLED → NEW (R5.6). The
   * general machine keeps this closed by default because only the raiser who
   * cancelled the request may reopen it, and that check belongs to the caller
   * (task 6.5). Defaults to `false`.
   */
  readonly allowReopen?: boolean;
}

/**
 * Whether `from` → `to` is a permitted transition (R9.4–9.7).
 *
 * A no-op (`from === to`) is NOT a transition and returns `false`. The
 * constrained reopen edge CANCELLED → NEW is only permitted when
 * `opts.allowReopen` is set; see {@link canReopen} for the intent-revealing
 * wrapper.
 */
export function canTransition(
  from: Status,
  to: Status,
  opts: TransitionOptions = {},
): boolean {
  if (opts.allowReopen && from === 'CANCELLED' && to === 'NEW') {
    return true;
  }
  return TRANSITIONS[from].has(to);
}

/**
 * Guard variant of {@link canTransition}: returns normally when the transition
 * is allowed, otherwise throws an {@link ApiError} (409 `INVALID_TRANSITION`,
 * R9.7) carrying the attempted `from`/`to` in `details` for diagnostics.
 */
export function assertTransition(
  from: Status,
  to: Status,
  opts: TransitionOptions = {},
): void {
  if (!canTransition(from, to, opts)) {
    throw new ApiError(
      409,
      'INVALID_TRANSITION',
      `Cannot move a request from ${from} to ${to}`,
      { from, to },
    );
  }
}

/**
 * The constrained raiser "Reopen" path: whether `from` → `to` is the reopen
 * edge CANCELLED → NEW (R5.6). Intent-revealing wrapper over
 * {@link canTransition} with `allowReopen`. The caller is still responsible for
 * verifying the current user is the raiser who cancelled the request (task 6.5);
 * this only says the STATUS move is a valid reopen.
 */
export function canReopen(from: Status, to: Status): boolean {
  return canTransition(from, to, { allowReopen: true }) && from === 'CANCELLED';
}

/**
 * Guard variant of {@link canReopen}: returns normally for the CANCELLED → NEW
 * reopen edge, otherwise throws `INVALID_TRANSITION` (R9.7). Use at the raiser
 * Reopen endpoint after the raiser/authorisation check has passed.
 */
export function assertReopen(from: Status, to: Status): void {
  if (!canReopen(from, to)) {
    throw new ApiError(
      409,
      'INVALID_TRANSITION',
      `Cannot reopen a request from ${from} to ${to}`,
      { from, to },
    );
  }
}

/**
 * The set of statuses reachable from `from` in one general-machine step
 * (excludes the constrained reopen edge). Useful for the support UI to offer
 * only the valid next statuses. Returns a fresh array in {@link STATUSES} order.
 */
export function allowedTargets(from: Status): Status[] {
  return STATUSES.filter((to) => TRANSITIONS[from].has(to));
}
