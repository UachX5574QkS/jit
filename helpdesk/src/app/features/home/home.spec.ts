import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Home, periodGreeting } from './home';
import { CurrentUserService } from '../../core/auth/current-user.service';

describe('Home', () => {
  let currentUser: CurrentUserService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Home],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    currentUser = TestBed.inject(CurrentUserService);
  });

  it('greets the current user by first name', () => {
    currentUser.setUser({
      id: 1,
      username: '11111111',
      displayName: 'Jason Hughes',
      roles: new Set(['USER']),
      teamsLed: [],
      teamsMemberOf: [],
      isAdmin: false,
      timezone: null,
    });
    const fixture = TestBed.createComponent(Home);
    fixture.detectChanges();
    const heading = (fixture.nativeElement as HTMLElement).querySelector('.greeting');
    expect(heading?.textContent).toContain('Jason');
  });

  it('derives the UK-English greeting period from local time', () => {
    expect(periodGreeting(new Date('2026-01-01T08:00:00'))).toBe('Good Morning');
    expect(periodGreeting(new Date('2026-01-01T14:00:00'))).toBe('Good Afternoon');
    expect(periodGreeting(new Date('2026-01-01T20:00:00'))).toBe('Good Evening');
    expect(periodGreeting(new Date('2026-01-01T03:00:00'))).toBe('Good Evening');
  });
});
