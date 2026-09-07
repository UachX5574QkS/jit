import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AdministerHome } from './administer-home';
import { CurrentUserService } from '../../core/auth/current-user.service';
import type { CurrentUser, Role } from '../../core/auth/current-user.model';

/**
 * Component tests for the Administer landing (task 14.1; R13.1, R14). They
 * exercise the role-scoped tile visibility: the Tool-Administrator tiles (Teams,
 * Data Points) appear only for administrators (R13.1), and a non-administrator
 * team leader sees none of them (their own tiles are task 14.2).
 */

function makeUser(roles: Role[]): CurrentUser {
  return {
    id: 1,
    username: '11111111',
    displayName: 'Test User',
    roles: new Set<Role>(roles),
    teamsLed: [],
    teamsMemberOf: [],
    isAdmin: roles.includes('ADMINISTRATOR'),
    timezone: null,
  };
}

describe('AdministerHome', () => {
  let currentUser: CurrentUserService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AdministerHome],
      providers: [provideRouter([])],
    }).compileComponents();
    currentUser = TestBed.inject(CurrentUserService);
  });

  function render() {
    const fixture = TestBed.createComponent(AdministerHome);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function tileLabels(el: HTMLElement): string[] {
    return Array.from(el.querySelectorAll('.tile-label')).map((n) => n.textContent?.trim() ?? '');
  }

  it('shows the Teams and Data Points tiles to an administrator (R13.1, R14)', () => {
    currentUser.setUser(makeUser(['USER', 'ADMINISTRATOR']));
    const el = render();
    const labels = tileLabels(el);
    expect(labels).toContain('Teams');
    expect(labels).toContain('Data Points');

    // The tiles link to the Tool-Administrator screens.
    const hrefs = Array.from(el.querySelectorAll('a.admin-tile')).map((a) =>
      a.getAttribute('href'),
    );
    expect(hrefs).toContain('/administer/teams');
    expect(hrefs).toContain('/administer/data-points');
  });

  it('shows the Team-Leader tiles (and hides admin tiles) for a non-admin team leader (R15.1, R16.1)', () => {
    currentUser.setUser(makeUser(['USER', 'TEAM_LEADER']));
    const el = render();
    const labels = tileLabels(el);
    // Tool-Administrator tiles are hidden from a non-administrator (R13.1).
    expect(labels).not.toContain('Teams');
    expect(labels).not.toContain('Data Points');
    // The Team-Leader tiles are shown (task 14.2; R15.1, R16.1).
    expect(labels).toContain('Team Membership');
    expect(labels).toContain('Tasks');

    const hrefs = Array.from(el.querySelectorAll('a.admin-tile')).map((a) =>
      a.getAttribute('href'),
    );
    expect(hrefs).toContain('/administer/teams-membership');
    expect(hrefs).toContain('/administer/tasks');
  });

  it('hides the Team-Leader tiles from a non-leader administrator (R15.1)', () => {
    currentUser.setUser(makeUser(['USER', 'ADMINISTRATOR']));
    const el = render();
    const labels = tileLabels(el);
    expect(labels).not.toContain('Team Membership');
    expect(labels).not.toContain('Tasks');
  });

  it('shows the union of tiles to an admin who is also a team leader (roles-additive)', () => {
    currentUser.setUser(makeUser(['ADMINISTRATOR', 'TEAM_LEADER']));
    const el = render();
    const labels = tileLabels(el);
    expect(labels).toContain('Teams');
    expect(labels).toContain('Data Points');
    expect(labels).toContain('Team Membership');
    expect(labels).toContain('Tasks');
  });
});
