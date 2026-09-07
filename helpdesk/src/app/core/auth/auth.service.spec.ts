import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { AuthService } from './auth.service';
import { CurrentUserService } from './current-user.service';
import type { CurrentUserDto } from './current-user.model';

const ME_DTO: CurrentUserDto = {
  id: 1,
  username: '11111111',
  displayName: 'Jason Hughes',
  roles: ['USER', 'ADMINISTRATOR'],
  teamsLed: [],
  teamsMemberOf: [],
  isAdmin: true,
  timezone: 'Europe/London',
};

describe('AuthService', () => {
  let service: AuthService;
  let currentUser: CurrentUserService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(AuthService);
    currentUser = TestBed.inject(CurrentUserService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('loads the dev login directory from GET /api/auth/users (R1.2)', async () => {
    const promise = firstValueFrom(service.listDirectory());
    const req = httpMock.expectOne('/api/auth/users');
    expect(req.request.method).toBe('GET');
    req.flush({
      users: [
        {
          username: '11111111',
          firstName: 'Jason',
          surname: 'Hughes',
          role: 'ADMINISTRATOR',
          label: '11111111 Jason (Administrator) Hughes',
        },
      ],
    });
    const users = await promise;
    expect(users.length).toBe(1);
    expect(users[0].label).toBe('11111111 Jason (Administrator) Hughes');
  });

  it('login posts credentials then resolves the current user (R1.3)', async () => {
    const promise = firstValueFrom(
      service.login({ username: '11111111', password: 'password1' }),
    );

    const loginReq = httpMock.expectOne('/api/auth/login');
    expect(loginReq.request.method).toBe('POST');
    expect(loginReq.request.body).toEqual({ username: '11111111', password: 'password1' });
    loginReq.flush(null, { status: 204, statusText: 'No Content' });

    const meReq = httpMock.expectOne('/api/auth/me');
    expect(meReq.request.method).toBe('GET');
    meReq.flush(ME_DTO);

    const user = await promise;
    expect(user.displayName).toBe('Jason Hughes');
    // The single identity source is populated after login (R1.7).
    expect(currentUser.isAuthenticated()).toBe(true);
    expect(currentUser.snapshot()?.username).toBe('11111111');
  });

  it('login propagates invalid-credential rejection without a session (R1.4)', async () => {
    const promise = firstValueFrom(
      service.login({ username: '11111111', password: 'wrong' }),
    );

    const loginReq = httpMock.expectOne('/api/auth/login');
    loginReq.flush(
      { error: { code: 'FORBIDDEN', message: 'Invalid username or password.' } },
      { status: 401, statusText: 'Unauthorized' },
    );

    await expect(promise).rejects.toBeTruthy();
    // No /auth/me is attempted on failure, and no identity is established.
    httpMock.expectNone('/api/auth/me');
    expect(currentUser.isAuthenticated()).toBe(false);
  });

  it('logout clears the session and local identity', async () => {
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

    const promise = firstValueFrom(service.logout());
    const req = httpMock.expectOne('/api/auth/logout');
    expect(req.request.method).toBe('POST');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await promise;

    expect(currentUser.isAuthenticated()).toBe(false);
  });
});
