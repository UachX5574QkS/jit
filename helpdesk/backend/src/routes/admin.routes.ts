import { Router } from 'express';
import { dataPointRouter } from './data-points.routes.js';
import { teamAdminRouter } from './team-admin.routes.js';
import { adminUsersRouter } from './admin-users.routes.js';
import { teamLeaderRouter } from './team-leader.routes.js';
import { taskLeaderRouter } from './task-leader.routes.js';

/**
 * Administration and team-leader routes
 * (design: Administration; R13, R14, R15, R16).
 *
 * Covers `/admin/*` and `/team-leader/*`. Sub-routers are mounted here as their
 * tasks land:
 *   - `/admin/teams` — Tool-Administrator team admin (task 5.1, R13, R20.2).
 *   - `/admin/users` — leader-picker source for the Teams screen (R13.2/13.3).
 *   - `/admin/data-points` — data point catalogue admin (task 5.2, R14, R20.4).
 *   - `/team-leader/teams` — team-leader team management (task 5.3, R15, R20.3).
 *   - `/team-leader/tasks` — team-leader task management (task 5.4, R16, R20.4).
 */
export const adminRouter = Router();

// Tool-Administrator team administration (admin-only; guards inside the router).
// Mounted at `/admin` so the router's own `/teams` paths resolve to
// `/admin/teams` and `/admin/teams/:id` (R13.2, R13.3, R20.2).
adminRouter.use('/admin', teamAdminRouter);

// Leader-picker source for the Teams screen (admin-only; R13.2/13.3).
adminRouter.use('/admin/users', adminUsersRouter);

// Data point administration (admin-only; guards live inside the sub-router).
adminRouter.use('/admin/data-points', dataPointRouter);

// Team-leader team management (leader-of-this-team; guards inside the sub-router).
adminRouter.use('/team-leader', teamLeaderRouter);

// Team-leader task management (leader-of-this-team; guards inside the sub-router).
adminRouter.use('/team-leader', taskLeaderRouter);
