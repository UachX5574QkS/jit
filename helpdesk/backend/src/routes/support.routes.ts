import { Router } from 'express';
import { registerSupportListRoute } from './support-list.routes.js';
import { DbSupportListStore } from './support-list.store.js';
import { registerSupportTeamMembersRoute } from './support-team-members.routes.js';
import { DbSupportTeamMembersStore } from './support-team-members.store.js';

/**
 * Support queue and time-tracking routes (design: Support side; R6, R7, R8).
 * Mounted at `/api/support` by the root router, so routes registered here are
 * relative to that prefix.
 *
 * Task 7.1 adds the Support-queue list (R6):
 *   GET /support/requests?team=&scope=mine|team&hideComplete=&showUnassigned=&q=
 *                          the Support screen queue — team drop-down (all vs a
 *                          specific membership-checked team), My Queue / Team
 *                          Queue toggle, hide-complete, show-unassigned, and
 *                          free-text search; returns the SAME request columns as
 *                          the Requests screen incl. hasOpenTimer and the
 *                          per-support-user "Updated" indicator.
 *
 * Task 12.2 adds the assignment drop-down source for the Support detail view
 * (R7.2):
 *   GET /support/teams/:id/members
 *                          the members of a team the caller belongs to, for the
 *                          "assign to any team member" drop-down; membership-
 *                          checked so a caller only ever sees their own teams'
 *                          membership.
 */
export const supportRouter = Router();

// Support queue list (R6). Available to support members (users in at least one
// team); the handler derives the team scope from CurrentUser.teamsMemberOf,
// enforces membership on an explicit team param (FORBIDDEN otherwise), and
// returns an empty list when the user is in no teams.
registerSupportListRoute(supportRouter, new DbSupportListStore());

// Support assignment drop-down source (R7.2): the members of a team the caller
// is a member of. The route membership-checks the team id against
// CurrentUser.teamsMemberOf (FORBIDDEN otherwise), so a support member only ever
// reads their own teams' membership.
registerSupportTeamMembersRoute(supportRouter, new DbSupportTeamMembersStore());
