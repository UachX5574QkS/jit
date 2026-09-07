import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { CurrentUserService } from '../../core/auth/current-user.service';

/** One tab in the statistics sub-navigation. */
interface StatsTab {
  readonly path: string;
  readonly label: string;
  /** When true, only shown to support members (R12.1). */
  readonly supportOnly?: boolean;
}

const TABS: readonly StatsTab[] = [
  { path: '/statistics/user', label: 'My Statistics' },
  { path: '/statistics/team', label: 'Team Statistics' },
  { path: '/statistics/support', label: 'Support Statistics', supportOnly: true },
];

/**
 * Sub-navigation for the Statistics feature. The sidebar exposes a single
 * "Stats" item (design: menu rendered from the role superset), so the three
 * dashboards — User (R10), Team (R11), and Support (R12) — are reachable via
 * this in-page tab strip shared by each dashboard.
 *
 * The Support Statistics tab is shown only to support members (R12.1); the
 * User and Team tabs are available to every authenticated user (a manager with
 * no reports simply sees an empty Team dashboard, R11.1).
 */
@Component({
  selector: 'app-stats-nav',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './stats-nav.html',
  styleUrl: './stats-nav.scss',
})
export class StatsNav {
  private readonly currentUser = inject(CurrentUserService);

  /** The visible tabs, filtered by role (Support is support-members-only). */
  protected readonly tabs = computed<StatsTab[]>(() => {
    const isSupport = this.currentUser.hasRole('SUPPORT_MEMBER');
    return TABS.filter((tab) => !tab.supportOnly || isSupport);
  });
}
