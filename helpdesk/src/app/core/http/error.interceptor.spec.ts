import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { CurrentUserService } from '../auth/current-user.service';
import { ApiError } from './api-error';
import { errorInterceptor } from './error.interceptor';

describe('errorInterceptor', () => {
  let http: HttpClient;
  let httpMock: HttpTestingController;
  let router: { navigate: ReturnType<typeof vi.fn> };
  let currentUser: CurrentUserService;

  beforeEach(() => {
    router = { navigate: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        { provide: Router, useValue: router },
      ],
    });
    http = TestBed.inject(HttpClient);
    httpMock = TestBed.inject(HttpTestingController);
    currentUser = TestBed.inject(CurrentUserService);
  });

  afterEach(() => httpMock.verify());

  it('maps a backend error envelope to an ApiError', async () => {
    const caught = firstError(http.get('/api/requests/5'));
    httpMock
      .expectOne('/api/requests/5')
      .flush(
        { error: { code: 'INVALID_TRANSITION', message: 'nope' } },
        { status: 409, statusText: 'Conflict' },
      );
    const err = await caught;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('INVALID_TRANSITION');
    expect((err as ApiError).status).toBe(409);
  });

  it('clears identity and routes to login on 401 (non /auth/me)', async () => {
    currentUser.setUser({
      id: 1,
      username: '1',
      displayName: 'x',
      roles: new Set(['USER']),
      teamsLed: [],
      teamsMemberOf: [],
      isAdmin: false,
      timezone: null,
    });

    const caught = firstError(http.get('/api/requests'));
    httpMock
      .expectOne('/api/requests')
      .flush(
        { error: { code: 'FORBIDDEN', message: 'no' } },
        { status: 401, statusText: 'Unauthorized' },
      );
    await caught;

    expect(currentUser.isAuthenticated()).toBe(false);
    expect(router.navigate).toHaveBeenCalledWith(['/login']);
  });

  it('does NOT redirect on a 401 from /auth/me (avoids a loop)', async () => {
    const caught = firstError(http.get('/api/auth/me'));
    httpMock
      .expectOne('/api/auth/me')
      .flush(
        { error: { code: 'FORBIDDEN', message: 'no' } },
        { status: 401, statusText: 'Unauthorized' },
      );
    await caught;

    expect(router.navigate).not.toHaveBeenCalled();
  });

  it('maps a network failure (status 0) to NETWORK_ERROR', async () => {
    const caught = firstError(http.get('/api/requests'));
    httpMock
      .expectOne('/api/requests')
      .error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
    const err = await caught;
    expect((err as ApiError).code).toBe('NETWORK_ERROR');
  });

  it('leaves non-API errors as-is', async () => {
    const caught = firstError(http.get('/assets/x.json'));
    httpMock.expectOne('/assets/x.json').flush('boom', { status: 500, statusText: 'Server Error' });
    const err = await caught;
    expect(err).not.toBeInstanceOf(ApiError);
  });
});

/** Resolve with the error the observable throws. */
function firstError(obs: {
  subscribe: (o: { error: (e: unknown) => void }) => void;
}): Promise<unknown> {
  return new Promise((resolve) => obs.subscribe({ error: resolve }));
}
