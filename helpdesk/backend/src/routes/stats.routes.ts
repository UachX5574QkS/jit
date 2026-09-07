import { Router } from 'express';
import { registerUserStatsRoute } from './stats-user.routes.js';
import { DbUserStatsStore } from './stats-user.store.js';
import { registerTeamStatsRoute } from './stats-team.routes.js';
import { DbTeamStatsStore } from './stats-team.store.js';
import { registerSupportStatsRoute } from './stats-support.routes.js';
import { DbSupportStatsStore } from './stats-support.store.js';

/**
 * Statistics routes (design: Statistics; R10, R11, R12, R18.3).
 * Mounted at `/api/stats`.
 *
 * Task 8.1 adds User Statistics (R10, R18.3):
 *   GET /stats/user[?tz=<IANA>]   status-by-month (viewer timezone), type-count
 *                                 pie, time-by-type pie, and a per-task-type
 *                                 summary table with average New→Triage and
 *                                 Triage→Complete durations (the latter
 *                                 excluding Rejected/Cancelled).
 *
 * Task 8.2 adds Team Statistics (R11, R19):
 *   GET /stats/team[?tz=<IANA>]   the SAME datasets as User Statistics, scoped
 *                                 to the requests raised by everyone in the
 *                                 caller's downward management hierarchy
 *                                 (area-manager cutoff + cycle guard reused
 *                                 from the task-3.6 resolver).
 *
 * Task 8.3 adds Support Statistics (R12):
 *   GET /stats/support[?team=|all&tz=<IANA>]
 *                                 a team selector + "All Teams" scoping (R12.1),
 *                                 status-by-month in the viewer's timezone
 *                                 (R12.2), an assigned-count table (Task or
 *                                 "Team - Task" rows × members, R12.3), and an
 *                                 Accepted→Complete average-duration table
 *                                 excluding Rejected/Cancelled (R12.4).
 */
export const statsRouter = Router();

// User Statistics: charts + summary table scoped to the caller's own requests,
// with month buckets computed in the viewer's timezone (R10, R18.3). Available
// to any authenticated user; it only ever aggregates the caller's requests.
registerUserStatsRoute(statsRouter, new DbUserStatsStore());

// Team Statistics: the same datasets scoped to the caller's downward management
// hierarchy (R11, R19). The store resolves the hierarchy through the shared
// manager-hierarchy resolver; the scope derives entirely from the caller's id.
registerTeamStatsRoute(statsRouter, new DbTeamStatsStore());

// Support Statistics: team-level tables + a status-by-month chart, scoped to a
// selected team or all the caller's teams (R12). The team drop-down is
// membership-checked against the caller's team memberships (support-member
// convention shared with the Support-queue list); the scope never spans a team
// the caller is not a member of.
registerSupportStatsRoute(statsRouter, new DbSupportStatsStore());
