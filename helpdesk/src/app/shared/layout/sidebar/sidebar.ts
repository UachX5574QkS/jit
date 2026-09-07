import { Component, computed, inject } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { CurrentUserService } from '../../../core/auth/current-user.service';
import { NAV_ITEMS, type NavItem, visibleNavItems } from '../../../core/auth/nav-items';

export type { NavItem } from '../../../core/auth/nav-items';

/**
 * 108px fixed icon sidebar for the ui-foundations shell.
 *
 * Renders the brand mark at the top (header aligned with the top header bar)
 * and an icon-with-label navigation list. The visible items are computed from
 * the current user's ADDITIVE role superset (R1.8): a person with several roles
 * sees the union of every role's menu items. The active route gets the
 * purple-bg background plus a 3px purple left border.
 */
@Component({
  selector: 'app-sidebar',
  imports: [RouterLink, RouterLinkActive],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.scss',
})
export class Sidebar {
  private readonly currentUser = inject(CurrentUserService);

  /** Menu rendered from the role superset; empty until the user resolves. */
  protected readonly items = computed<NavItem[]>(() =>
    visibleNavItems(this.currentUser.roles(), NAV_ITEMS),
  );
}
