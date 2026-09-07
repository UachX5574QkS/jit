import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { Login } from './login';
import { CurrentUserService } from '../../core/auth/current-user.service';
import type { CurrentUserDto } from '../../core/auth/current-user.model';

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

const DIRECTORY = {
  users: [
    {
      username: '11111111',
      firstName: 'Jason',
      surname: 'Hughes',
      role: 'ADMINISTRATOR',
      label: '11111111 Jason (Administrator) Hughes',
    },
    {
      username: '22222222',
      firstName: 'Sam',
      surname: 'Lee',
      role: 'USER',
      label: '22222222 Sam (User) Lee',
    },
  ],
};

describe('Login', () => {
  let httpMock: HttpTestingController;
  let router: Router;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Login],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
  });

  /** Create the component and satisfy the initial directory load. */
  function create(directory: typeof DIRECTORY = DIRECTORY) {
    const fixture = TestBed.createComponent(Login);
    fixture.detectChanges();
    const req = httpMock.expectOne('/api/auth/users');
    req.flush(directory);
    fixture.detectChanges();
    return fixture;
  }

  function el(fixture: ReturnType<typeof create>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('creates and shows a login card', () => {
    const fixture = create();
    expect(el(fixture).querySelector('#login-heading')).toBeTruthy();
    httpMock.verify();
  });

  it('populates the dev drop-down from GET /api/auth/users (R1.2)', () => {
    const fixture = create();
    const select = el(fixture).querySelector('#login-username') as HTMLSelectElement;
    expect(select.tagName.toLowerCase()).toBe('select');
    const optionLabels = Array.from(select.querySelectorAll('option'))
      .map((o) => o.textContent?.trim())
      .filter((t) => t && !t.startsWith('Select'));
    expect(optionLabels).toEqual([
      '11111111 Jason (Administrator) Hughes',
      '22222222 Sam (User) Lee',
    ]);
    httpMock.verify();
  });

  it('falls back to a text field when the directory is empty/unavailable', () => {
    const fixture = TestBed.createComponent(Login);
    fixture.detectChanges();
    httpMock
      .expectOne('/api/auth/users')
      .flush({ error: { code: 'NOT_FOUND', message: 'no' } }, { status: 404, statusText: 'NF' });
    fixture.detectChanges();
    const input = el(fixture as never).querySelector('#login-username') as HTMLInputElement;
    expect(input.tagName.toLowerCase()).toBe('input');
    httpMock.verify();
  });

  it('logs in and redirects on success (R1.3)', () => {
    const fixture = create();
    const comp = fixture.componentInstance as unknown as {
      onUsernameChange(v: string): void;
      onPasswordChange(v: string): void;
      submit(): void;
    };
    comp.onUsernameChange('11111111');
    comp.onPasswordChange('password1');
    comp.submit();

    const loginReq = httpMock.expectOne('/api/auth/login');
    expect(loginReq.request.body).toEqual({ username: '11111111', password: 'password1' });
    loginReq.flush(null, { status: 204, statusText: 'No Content' });

    httpMock.expectOne('/api/auth/me').flush(ME_DTO);

    const currentUser = TestBed.inject(CurrentUserService);
    expect(currentUser.isAuthenticated()).toBe(true);
    expect(router.navigateByUrl).toHaveBeenCalledWith('/');
    httpMock.verify();
  });

  it('shows an inline error and does not redirect on invalid credentials (R1.4)', () => {
    const fixture = create();
    const comp = fixture.componentInstance as unknown as {
      onUsernameChange(v: string): void;
      onPasswordChange(v: string): void;
      submit(): void;
    };
    comp.onUsernameChange('11111111');
    comp.onPasswordChange('wrong');
    comp.submit();

    httpMock
      .expectOne('/api/auth/login')
      .flush(
        { error: { code: 'FORBIDDEN', message: 'Invalid username or password.' } },
        { status: 401, statusText: 'Unauthorized' },
      );
    fixture.detectChanges();

    // No /auth/me on failure, no navigation, and an error is shown.
    httpMock.expectNone('/api/auth/me');
    expect(router.navigateByUrl).not.toHaveBeenCalled();
    const alert = el(fixture).querySelector('.login-error');
    expect(alert?.textContent).toContain('Invalid username or password.');
    httpMock.verify();
  });
});
