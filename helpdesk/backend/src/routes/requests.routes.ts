import { Router } from 'express';
import { registerWorkflowSupportRoutes } from './workflow-support.routes.js';
import { DbWorkflowSupportStore } from './workflow-support.store.js';
import { registerReviewRoutes } from './review.routes.js';
import { HttpOllamaClient } from './ollama-client.js';
import { registerCreateRequestRoute } from './requests-create.routes.js';
import { DbRequestCreateStore } from './requests-create.store.js';
import { registerRequestListRoute } from './requests-list.routes.js';
import { DbRequestListStore } from './requests-list.store.js';
import { registerRequestDetailRoute } from './requests-detail.routes.js';
import { DbRequestDetailStore } from './requests-detail.store.js';
import { registerRequestUserMutationRoutes } from './requests-user-mutations.routes.js';
import { DbRequestUserMutationsStore } from './requests-user-mutations.store.js';
import { registerRequestNotesRoutes } from './requests-notes.routes.js';
import { DbRequestNotesStore } from './requests-notes.store.js';
import { registerRequestSupportMutationRoutes } from './requests-support-mutations.routes.js';
import { DbRequestSupportMutationsStore } from './requests-support-mutations.store.js';
import { registerEstimatedEffortRoute } from './requests-estimated-effort.routes.js';
import { DbEstimatedEffortStore } from './requests-estimated-effort.store.js';
import { registerRequestTimerRoutes } from './requests-timer.routes.js';
import { DbRequestTimerStore } from './requests-timer.store.js';

/**
 * User-side request lifecycle plus workflow-support routes
 * (design: Requests, Workflow support; R2, R3, R4, R5).
 *
 * Covers `/requests`, `/tasks`, `/teams`, and `/review/summary`. Handlers are
 * implemented in tasks 6.x.
 *
 * Task 6.1 adds the New-workflow support reads on `/teams` and `/tasks`:
 *   GET /teams?open=true                non-closed teams for Step 1 (R2.3)
 *   GET /teams/:id/tasks?active=true    that team's non-retired tasks (R2.3)
 *   GET /tasks/:id/current-version      the task's current version fields
 *                                       (R2.5–2.8, R3.5)
 *
 * Task 6.2 adds the Step 3 review summary (server-side Ollama, R2.11–2.12):
 *   POST /review/summary   { taskVersionId, values } → summary | {available:false}
 *
 * Task 6.3 adds the submit endpoint (R2.14):
 *   POST /requests         create with unique reference, status NEW, pinned
 *                          task version, timestamps, validated field values
 *
 * Task 6.6 adds the Requests list (R4.1–4.4, R4.9, R19):
 *   GET /requests?scope=mine|team&hideComplete=&q=
 *                          list for the Requests screen; scope=mine → raised by
 *                          the current user, scope=team → raised by anyone in
 *                          the current user's downward hierarchy; hide-complete
 *                          excludes stop states; q searches any field in scope
 *
 * Task 6.4 adds the detail read (R5.1, R5.2, R17.4):
 *   GET /requests/:id      full detail (request row, pinned version fields
 *                          merged with values, notes, column-level audit trail);
 *                          internal notes + internal-note audit entries excluded
 *                          for non-support viewers; records the viewer's
 *                          last_seen so their "Updated" indicator clears
 *
 * Task 6.5 adds the user-side mutations (R5.3–5.8):
 *   PATCH /requests/:id/user-fields  raiser updates Jira + user fields;
 *                                    mandatory not blankable (R5.4)
 *   POST  /requests/:id/cancel       raiser, non-stop → CANCELLED (R5.5)
 *   POST  /requests/:id/reopen       raiser-who-cancelled, CANCELLED → NEW (R5.6)
 *   POST  /requests/:id/clone        pre-populated draft for Step 2 (R5.8)
 *
 * Task 6.7 adds the type-level Estimated Effort read (R4.7):
 *   GET /tasks/:taskId/estimated-effort  sum of recorded time-slice durations
 *                                        across the task type's COMPLETE
 *                                        requests ÷ the number of COMPLETE
 *                                        requests of that type (across all
 *                                        versions); null estimate when none
 */
export const requestsRouter = Router();

// New-workflow support reads (any authenticated user; global authenticate
// middleware upstream already enforces authentication).
registerWorkflowSupportRoutes(requestsRouter, new DbWorkflowSupportStore());

// New-workflow Step 3 review summary (display-only, not persisted; any
// authenticated user). Falls back to the entered values on Ollama failure.
registerReviewRoutes(requestsRouter, new HttpOllamaClient());

// New-workflow Submit: create the request (any authenticated user is the
// raiser). Assigns a unique reference, status NEW, pins the task version,
// validates + persists field values, and audits in one transaction (R2.14).
registerCreateRequestRoute(requestsRouter, new DbRequestCreateStore());

// Requests list: return the rows the Requests screen needs for the active
// scope (mine | team), applying hide-complete and free-text search (R4.1–4.4,
// R4.9). scope=team is resolved through the shared manager-hierarchy resolver
// (R19). Registered before the detail route; `/requests` and `/requests/:id`
// are distinct paths so order is not load-bearing.
registerRequestListRoute(requestsRouter, new DbRequestListStore());

// Request detail: return the full request (row, pinned version fields merged
// with values, notes, audit trail), excluding internal notes / internal-note
// audit entries for non-support viewers, and record the viewer's last_seen
// (R5.1, R5.2, R17.4). Visible to the raiser, a support member of the team, or
// a manager in the raiser's hierarchy.
registerRequestDetailRoute(requestsRouter, new DbRequestDetailStore());

// User-side mutations (R5.3–5.8): the raiser updates Jira + user fields
// (mandatory not blankable), adds an external note, cancels (from a non-stop
// state) and reopens (only the raiser who cancelled); any authorised viewer may
// clone a request into a pre-populated New-workflow draft. The fine-grained
// raiser/canceller/viewer gates live in the store; the only status changes are
// the cancel/reopen paths (R5.7 by construction).
registerRequestUserMutationRoutes(requestsRouter, new DbRequestUserMutationsStore());

// Unified add-note (task 6.5 raiser external note R5.3 + task 7.3 support
// internal/external note R7.3–7.6): the design lists a SINGLE
// `POST /api/requests/{id}/notes` for both audiences, so one endpoint serves
// them and the store branches on the caller's relationship to the request — a
// support member of the request's team may set `isInternal` (default false);
// the raiser (not support) is forced to an external note; anyone else is
// FORBIDDEN. An EXTERNAL note bumps `updated_at` so the raiser's "Updated"
// indicator fires (R7.6); an INTERNAL note does NOT, so it never flags the
// raiser's Requests view (R7.5) but still surfaces to support on the Support
// detail/audit. Registered on the same requests router; `/requests/:id/notes`
// does not collide with the plain `PATCH /requests/:id` or the other
// `/requests/:id/*` user-side sub-routes.
registerRequestNotesRoutes(requestsRouter, new DbRequestNotesStore());

// Support-side mutation (R7.1, R7.2, R9): a support member of the request's
// team updates any field value, the Jira number, the estimated/actual start
// dates, the status (validated by the central state machine — COMPLETE only
// from ACTIVE, cancel-from-any-non-stop, else INVALID_TRANSITION), and/or the
// assignment (any team member, or unassign; a non-member assignee is rejected).
// Every change is column-level audited in one transaction and bumps updated_at
// so the raiser's "Updated" indicator fires. The plain `PATCH /requests/:id`
// path does not collide with the user-side `/requests/:id/*` sub-routes above.
// Timer auto-stop on leaving ACTIVE is task 7.4 and is not implemented here.
registerRequestSupportMutationRoutes(requestsRouter, new DbRequestSupportMutationsStore());

// Estimated Effort (R4.7): the type-level average recorded effort on a COMPLETE
// request of a task type — SUM of the type's complete-request time-slice
// durations ÷ the count of those complete requests, aggregated over all
// versions of the task. Available to any authenticated user; a null estimate is
// returned cleanly when the type has no complete requests, and an unknown task
// id is a 404.
registerEstimatedEffortRoute(requestsRouter, new DbEstimatedEffortStore());

// Time tracking (R8): a support member of the request's team starts a timer
// (ACTIVE-only, R8.1/R8.2), resolves the concurrent-timer prompt on start
// (stopOthers, R8.8), stops it to record a time_slice with an editable duration
// (> 1 minute when edited → TIMER_MIN_DURATION, R8.4–8.6), and lists their open
// timer(s) for the prompt (R8.8). Auto-stop-and-record when a request LEAVES
// ACTIVE is layered onto the support-side status change (see
// requests-support-mutations.store.ts) so a running timer is never discarded.
// The `/requests/:id/timer(s)/…` sub-paths do not collide with the plain
// `PATCH /requests/:id` or the other `/requests/:id/*` routes above.
registerRequestTimerRoutes(requestsRouter, new DbRequestTimerStore());
