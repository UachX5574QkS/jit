/**
 * The central request status state machine (design: "Status enum & state
 * machine", R9).
 *
 * Feature code that changes a request's status imports the {@link Status} type,
 * the stop-state predicate {@link isStopState}, and the transition
 * guards/predicates from here and nowhere else, so the transition rules
 * (R9.4–9.7) and the constrained raiser Reopen path (R5.6) live behind a single
 * seam. Support updates (task 7.2) and the raiser Cancel/Reopen flow (task 6.5)
 * both validate through this module.
 */
export type { Status, TransitionOptions } from './status.js';
export {
  STATUSES,
  STOP_STATES,
  isStatus,
  isStopState,
  canTransition,
  assertTransition,
  canReopen,
  assertReopen,
  allowedTargets,
} from './status.js';
