import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { CurrentUserService } from './current-user.service';
import type { CurrentUserDto } from './current-user.model';

const ME_DTO: CurrentUserDto = {
  id: 7,
  username: '22222222',
  displayName: 'Sam Lee',
  roles: ['USER', 'SUPPORT_MEMBER', 'TEAM_LEADER'],
  teamsLed: [3],
  teamsMemberOf: [3, 4],
  isAdmin: false,
  timezone: 'Europe/London',
};

describe('CurrentUserService', () => {
  let service: CurrentUserService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(CurrentUserService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('starts unauthenticated and unloaded', () => {
    expect(service.isAuthenticated()).toBe(false);
    expect(service.loaded()).toBe(false);
    expect(service.snapshot()).toBeNull();
  });

  it('loads the current user from GET /api/auth/me', async () => {
    const promise = firstValueFrom(service.load());
    const req = httpMock.expectOne('/api/auth/me');
    expect(req.request.method).toBe('GET');
    req.flush(ME_DTO);
    await promise;

    expect(service.isAuthenticated()).toBe(true);
    expect(service.loaded()).toBe(true);
    expect(service.snapshot()?.displayName).toBe('Sam Lee');
  });

  it('exposes the additive role superset and helpers', async () => {
    const promise = firstValueFrom(service.load());
    httpMock.expectOne('/api/auth/me').flush(ME_DTO);
    await promise;

    expect(service.hasRole('SUPPORT_MEMBER')).toBe(true);
    expect(service.hasRole('ADMINISTRATOR')).toBe(false);
    expect(service.hasAnyRole(['ADMINISTRATOR', 'TEAM_LEADER'])).toBe(true);
    expect(service.hasAllRoles(['USER', 'SUPPORT_MEMBER'])).toBe(true);
    expect(service.hasAllRoles(['USER', 'ADMINISTRATOR'])).toBe(false);
    expect(service.leadsTeam(3)).toBe(true);
    expect(service.leadsTeam(99)).toBe(false);
    expect(service.isMemberOfTeam(4)).toBe(true);
  });

  it('clears the user and marks loaded on a failed load', async () => {
    const promise = firstValueFrom(service.load());
    httpMock
      .expectOne('/api/auth/me')
      .flush(
        { error: { code: 'FORBIDDEN', message: 'no' } },
        { status: 401, statusText: 'Unauthorized' },
      );
    // load() taps the error to reset state, then rethrows; swallow it here.
    await promise.catch(() => undefined);

    expect(service.isAuthenticated()).toBe(false);
    expect(service.loaded()).toBe(true);
  });

  it('setUser / clear update the resolved identity', () => {
    service.setUser({
      id: 1,
      username: '11111111',
      displayName: 'A B',
      roles: new Set(['USER', 'ADMINISTRATOR']),
      teamsLed: [],
      teamsMemberOf: [],
      isAdmin: true,
      timezone: null,
    });
    expect(service.isAdmin()).toBe(true);
    expect(service.hasRole('ADMINISTRATOR')).toBe(true);

    service.clear();
    expect(service.isAuthenticated()).toBe(false);
    expect(service.hasRole('ADMINISTRATOR')).toBe(false);
  });

  it('helpers return false when unauthenticated', () => {
    expect(service.hasRole('USER')).toBe(false);
    expect(service.hasAnyRole(['USER'])).toBe(false);
    expect(service.hasAllRoles(['USER'])).toBe(false);
    expect(service.leadsTeam(1)).toBe(false);
    expect(service.isMemberOfTeam(1)).toBe(false);
  });
});
