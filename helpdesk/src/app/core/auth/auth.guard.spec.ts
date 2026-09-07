import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, UrlTree, type CanActivateFn } from '@angular/router';
import { CurrentUserService } from './current-user.service';
import type { CurrentUser, Role } from './current-user.model';
import {
  adminGuard,
  administerGuard,
  authGuard,
  supportGuard,
  teamLeaderGuard,
} from './auth.guard';

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

/** Run a CanActivateFn inside the DI context and normalise the result. */
async function run(guard: CanActivateFn): Promise<boolean | UrlTree> {
  const result = TestBed.runInInjectionContext(() => guard({} as never, {} as never));
  // Guards here return a Promise; unwrap it.
  return await (result as Promise<boolean | UrlTree>);
}

describe('auth.guard', () => {
  let service: CurrentUserService;
  let httpMock: HttpTestingController;
  let router: Router;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(CurrentUserService);
    httpMock = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
  });

  it('authGuard redirects unauthenticated users to login', async () => {
    // Force "loaded but no user" so the guard does not attempt a network load.
    service.clear();
    const result = await run(authGuard);
    expect(result).toBeInstanceOf(UrlTree);
    expect(router.serializeUrl(result as UrlTree)).toBe('/login');
  });

  it('authGuard allows any authenticated user', async () => {
    service.setUser(makeUser(['USER']));
    expect(await run(authGuard)).toBe(true);
  });

  it('supportGuard allows support members, blocks others', async () => {
    service.setUser(makeUser(['USER']));
    const denied = await run(supportGuard);
    expect(denied).toBeInstanceOf(UrlTree);
    expect(router.serializeUrl(denied as UrlTree)).toBe('/');

    service.setUser(makeUser(['USER', 'SUPPORT_MEMBER']));
    expect(await run(supportGuard)).toBe(true);
  });

  it('adminGuard requires ADMINISTRATOR', async () => {
    service.setUser(makeUser(['USER', 'TEAM_LEADER']));
    expect(await run(adminGuard)).toBeInstanceOf(UrlTree);

    service.setUser(makeUser(['USER', 'ADMINISTRATOR']));
    expect(await run(adminGuard)).toBe(true);
  });

  it('teamLeaderGuard requires TEAM_LEADER', async () => {
    service.setUser(makeUser(['USER']));
    expect(await run(teamLeaderGuard)).toBeInstanceOf(UrlTree);

    service.setUser(makeUser(['USER', 'TEAM_LEADER']));
    expect(await run(teamLeaderGuard)).toBe(true);
  });

  it('administerGuard admits either administrators or team leaders', async () => {
    service.setUser(makeUser(['USER', 'TEAM_LEADER']));
    expect(await run(administerGuard)).toBe(true);

    service.setUser(makeUser(['USER', 'ADMINISTRATOR']));
    expect(await run(administerGuard)).toBe(true);

    service.setUser(makeUser(['USER']));
    expect(await run(administerGuard)).toBeInstanceOf(UrlTree);
  });

  it('loads /auth/me on first use when not yet loaded', async () => {
    // Not loaded → guard triggers a load; resolve it as an authenticated user.
    const resultPromise = run(authGuard);
    const req = httpMock.expectOne('/api/auth/me');
    req.flush({
      id: 1,
      username: '11111111',
      displayName: 'Test',
      roles: ['USER'],
      teamsLed: [],
      teamsMemberOf: [],
      isAdmin: false,
      timezone: null,
    });
    expect(await resultPromise).toBe(true);
  });
});
