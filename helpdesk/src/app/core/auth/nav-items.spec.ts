import type { Role } from './current-user.model';
import { NAV_ITEMS, visibleNavItems } from './nav-items';

function roles(...r: Role[]): ReadonlySet<Role> {
  return new Set<Role>(r);
}

describe('nav-items', () => {
  it('shows only the user-facing items to a plain user', () => {
    const paths = visibleNavItems(roles('USER')).map((i) => i.path);
    expect(paths).toEqual(['/new', '/requests', '/statistics']);
  });

  it('adds Support for a support member', () => {
    const paths = visibleNavItems(roles('USER', 'SUPPORT_MEMBER')).map((i) => i.path);
    expect(paths).toContain('/support');
  });

  it('adds Administer for an administrator', () => {
    const paths = visibleNavItems(roles('USER', 'ADMINISTRATOR')).map((i) => i.path);
    expect(paths).toContain('/administer');
  });

  it('adds Administer for a team leader (union with admin tiles)', () => {
    const paths = visibleNavItems(roles('USER', 'TEAM_LEADER')).map((i) => i.path);
    expect(paths).toContain('/administer');
  });

  it('renders the union of items for a multi-role user (superset)', () => {
    const paths = visibleNavItems(
      roles('USER', 'SUPPORT_MEMBER', 'TEAM_LEADER', 'ADMINISTRATOR'),
    ).map((i) => i.path);
    expect(paths).toEqual(NAV_ITEMS.map((i) => i.path));
  });

  it('shows nothing to an unauthenticated (empty-role) principal', () => {
    expect(visibleNavItems(roles())).toEqual([]);
  });

  it('treats an item with no requiredRoles as always visible', () => {
    const custom = [{ path: '/x', label: 'X', icon: 'new' as const }];
    expect(visibleNavItems(roles(), custom)).toHaveLength(1);
  });
});
