import { Routes } from '@angular/router';
import {
  adminGuard,
  administerGuard,
  authGuard,
  supportGuard,
  teamLeaderGuard,
} from './core/auth/auth.guard';
import { LayoutShell } from './shared/layout/layout-shell/layout-shell';
import { Login } from './features/login/login';
import { Home } from './features/home/home';
import { NewWorkflow } from './features/new/new-workflow';
import { RequestsList } from './features/requests/requests-list';
import { RequestDetail } from './features/requests/request-detail';
import { SupportQueue } from './features/support/support-queue';
import { SupportDetail } from './features/support/support-detail';
import { UserStatistics } from './features/statistics/user-statistics';
import { TeamStatistics } from './features/statistics/team-statistics';
import { SupportStatistics } from './features/statistics/support-statistics';
import { AdministerHome } from './features/administer/administer-home';
import { TeamAdmin } from './features/administer/team-admin';
import { DataPointAdmin } from './features/administer/data-point-admin';
import { TeamMembership } from './features/administer/team-membership';
import { TaskLeaderAdmin } from './features/administer/task-leader-admin';

/**
 * Top-level application routes (design: "Route guards", R1).
 *
 * ── Login vs shell ───────────────────────────────────────────────────────────
 * The login screen renders OUTSIDE the ui-foundations shell (no sidebar/header
 * before authentication, R1.1). Everything else lives under the {@link LayoutShell}
 * layout route, which is protected by {@link authGuard}: an unauthenticated
 * visitor is redirected to `/login` (R1.1), and once authenticated the shell's
 * sidebar renders the menu from the user's role superset (R1.8).
 *
 * Feature routes (New, Requests, Support, Statistics, Administer) are added by
 * their tasks as children of the shell; `Home` is the interim authenticated
 * landing the login flow navigates to (R1.3). The Support queue additionally
 * carries {@link supportGuard} so only support members can reach it (R6.1).
 * Statistics is available to every authenticated user (R10, R11); `/statistics`
 * and `/statistics/user` both render the User Statistics dashboard (the
 * sidebar's "Stats" item links to `/statistics`), and `/statistics/team`
 * renders the Team Statistics dashboard scoped to the caller's downward
 * management hierarchy (R11, R19). `/statistics/support` renders the Support
 * Statistics dashboard and carries {@link supportGuard} so only support members
 * (members of at least one team) can reach it (R12.1); the stats-nav's
 * Support-only tab links to it. The three dashboards are reached via the in-page
 * statistics tab strip.
 */
export const routes: Routes = [
  { path: 'login', component: Login },
  {
    path: '',
    component: LayoutShell,
    canActivate: [authGuard],
    children: [
      { path: '', component: Home },
      { path: 'new', component: NewWorkflow },
      { path: 'requests', component: RequestsList },
      { path: 'requests/:id', component: RequestDetail },
      { path: 'support', component: SupportQueue, canActivate: [supportGuard] },
      { path: 'support/:id', component: SupportDetail, canActivate: [supportGuard] },
      { path: 'statistics', component: UserStatistics },
      { path: 'statistics/user', component: UserStatistics },
      { path: 'statistics/team', component: TeamStatistics },
      {
        path: 'statistics/support',
        component: SupportStatistics,
        canActivate: [supportGuard],
      },
      // Administer area (design: "Administer — admin tiles + team-leader tiles").
      // The landing is reachable by administrators OR team leaders
      // (administerGuard); each tile is scoped to its role inside the feature
      // (R13.1, R15.1). The Tool-Administrator screens (Teams, Data Points) are
      // administrator-only via adminGuard (R13.1, R14); the Team-Leader screens
      // (Team Membership, Tasks) are team-leader-only via teamLeaderGuard
      // (R15.1, R16.1). Server enforces the real boundary on every endpoint.
      { path: 'administer', component: AdministerHome, canActivate: [administerGuard] },
      { path: 'administer/teams', component: TeamAdmin, canActivate: [adminGuard] },
      {
        path: 'administer/data-points',
        component: DataPointAdmin,
        canActivate: [adminGuard],
      },
      // Team-Leader screens (task 14.2). Reachable only by team leaders
      // (teamLeaderGuard, R15.1/R16.1); the leader-of-THIS-team boundary is
      // enforced server-side on every /team-leader endpoint.
      {
        path: 'administer/teams-membership',
        component: TeamMembership,
        canActivate: [teamLeaderGuard],
      },
      {
        path: 'administer/tasks',
        component: TaskLeaderAdmin,
        canActivate: [teamLeaderGuard],
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
