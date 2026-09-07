import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { CurrentUserService } from '../../../core/auth/current-user.service';
import type { CurrentUser, Role } from '../../../core/auth/current-user.model';
import { Sidebar } from './sidebar';

function makeUser(roles: Role[]): CurrentUser {
  return {
    id: 1,
    username: '11111111',
    displayName: 'Test',
    roles: new Set<Role>(roles),
    teamsLed: [],
    teamsMemberOf: [],
    isAdmin: roles.includes('ADMINISTRATOR'),
    timezone: null,
  };
}

describe('Sidebar', () => {
  let currentUser: CurrentUserService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Sidebar],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    currentUser = TestBed.inject(CurrentUserService);
  });

  function labels(): string[] {
    const fixture = TestBed.createComponent(Sidebar);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return Array.from(el.querySelectorAll('.nav-label')).map((n) => n.textContent?.trim() ?? '');
  }

  it('creates', () => {
    const fixture = TestBed.createComponent(Sidebar);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('exposes a labelled primary navigation region', async () => {
    const fixture = TestBed.createComponent(Sidebar);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('nav[aria-label="Primary"]')).toBeTruthy();
  });

  it('renders only user-facing items for a plain user', () => {
    currentUser.setUser(makeUser(['USER']));
    expect(labels()).toEqual(['New', 'Requests', 'Stats']);
  });

  it('renders the superset of items for a multi-role user', () => {
    currentUser.setUser(makeUser(['USER', 'SUPPORT_MEMBER', 'ADMINISTRATOR']));
    expect(labels()).toEqual(['New', 'Requests', 'Support', 'Stats', 'Administer']);
  });

  it('renders no items when unauthenticated', () => {
    currentUser.clear();
    expect(labels()).toEqual([]);
  });
});
