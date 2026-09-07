import type { Role } from './current-user.model';

/** The inline SVG icon keys the sidebar template knows how to render. */
export type NavIcon = 'new' | 'requests' | 'support' | 'statistics' | 'administer';

/**
 * A primary navigation entry and the roles that make it visible.
 *
 * `requiredRoles` is a set of roles ANY of which reveals the item. Because the
 * current user's roles are the additive superset of their memberships, a person
 * with several roles sees the UNION of the items each role grants (R1.8,
 * roles-additive). An empty/omitted `requiredRoles` means "every authenticated
 * user" — e.g. New and Statistics are available to everyone (R2.1).
 */
export interface NavItem {
  /** Router path this item links to. */
  readonly path: string;
  /** Short label rendered beneath the icon. */
  readonly label: string;
  /** Icon key selecting one of the inline SVGs in the sidebar template. */
  readonly icon: NavIcon;
  /** Roles that reveal this item (any-of). Omit for "all authenticated". */
  readonly requiredRoles?: readonly Role[];
}

/**
 * The full primary menu, in display order. Visibility per item is decided from
 * the current user's role superset by {@link visibleNavItems}.
 *
 *   • New / Requests / Statistics — available to every authenticated user
 *     (USER); everyone can raise and track requests (R2.1, R4, R10).
 *   • Support — support members only (R6.1).
 *   • Administer — administrators (R13.1) or team leaders (R15.1); the union of
 *     Tool-Administrator and Team-Leader tiles is decided inside the feature.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  { path: '/new', label: 'New', icon: 'new', requiredRoles: ['USER'] },
  { path: '/requests', label: 'Requests', icon: 'requests', requiredRoles: ['USER'] },
  { path: '/support', label: 'Support', icon: 'support', requiredRoles: ['SUPPORT_MEMBER'] },
  { path: '/statistics', label: 'Stats', icon: 'statistics', requiredRoles: ['USER'] },
  {
    path: '/administer',
    label: 'Administer',
    icon: 'administer',
    requiredRoles: ['ADMINISTRATOR', 'TEAM_LEADER'],
  },
];

/**
 * Filter the menu to the items the given role superset may see (R1.8). An item
 * with no `requiredRoles` is always visible; otherwise it is shown when the
 * user holds AT LEAST ONE of its required roles — so the rendered menu is the
 * union of what all the user's roles grant.
 */
export function visibleNavItems(
  roles: ReadonlySet<Role>,
  items: readonly NavItem[] = NAV_ITEMS,
): NavItem[] {
  return items.filter((item) => {
    if (!item.requiredRoles || item.requiredRoles.length === 0) {
      return true;
    }
    return item.requiredRoles.some((role) => roles.has(role));
  });
}
