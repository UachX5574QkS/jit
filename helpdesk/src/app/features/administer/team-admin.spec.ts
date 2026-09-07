import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TeamAdmin } from './team-admin';
import type { AdminUserView, TeamView } from './team-admin.service';
import { errorInterceptor } from '../../core/http/error.interceptor';

/**
 * Component tests for the Tool-Administrator Teams screen (task 14.1; R13,
 * R20.2). They exercise the behaviours the task calls out: list teams, create a
 * team, change a team's leader, and close a team — including the graceful
 * handling of `CONFLICT_OPEN_REQUESTS` when a close is blocked (R20.2).
 */

function team(overrides: Partial<TeamView> = {}): TeamView {
  return {
    id: 1,
    title: 'Access Management',
    description: 'Handles access requests',
    teamLeaderId: 10,
    isClosed: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const USERS: AdminUserView[] = [
  { id: 10, username: '10000000', displayName: 'Grace Hopper' },
  { id: 11, username: '11000000', displayName: 'Alan Turing' },
];

describe('TeamAdmin', () => {
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TeamAdmin],
      providers: [
        // Register the error interceptor so a failed API call surfaces as an
        // ApiError (mirroring the app), letting the component branch on the code
        // (e.g. CONFLICT_OPEN_REQUESTS, R20.2).
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
  });

  /** Create the component and flush the initial teams + users load. */
  function create(teams: TeamView[] = [team()], users: AdminUserView[] = USERS) {
    const fixture = TestBed.createComponent(TeamAdmin);
    fixture.detectChanges();
    httpMock.expectOne((r) => r.url === '/api/admin/teams' && r.method === 'GET').flush({ teams });
    httpMock.expectOne((r) => r.url === '/api/admin/users' && r.method === 'GET').flush({ users });
    fixture.detectChanges();
    return fixture;
  }

  it('lists teams with their resolved leader name (R13.3)', () => {
    const fixture = create([team({ id: 1, title: 'Access Management', teamLeaderId: 10 })]);
    const el = fixture.nativeElement as HTMLElement;
    const rows = el.querySelectorAll('.admin-table tbody tr.team-row');
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain('Access Management');
    // The leader select for an open team is pre-selected to the current leader.
    const select = rows[0].querySelector<HTMLSelectElement>('select.leader-select');
    expect(select?.value).toBe('10');
    httpMock.verify();
  });

  it('creates a team and appends it to the table (R13.2)', () => {
    const fixture = create([]);
    const c = fixture.componentInstance as unknown as {
      newTitle: { set(v: string): void };
      newLeaderId: { set(v: number): void };
      createTeam(): void;
    };
    c.newTitle.set('Networking');
    c.newLeaderId.set(11);
    fixture.detectChanges();

    c.createTeam();
    const req = httpMock.expectOne((r) => r.url === '/api/admin/teams' && r.method === 'POST');
    expect(req.request.body).toEqual({
      title: 'Networking',
      description: null,
      teamLeaderId: 11,
    });
    req.flush(team({ id: 2, title: 'Networking', teamLeaderId: 11 }));
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Networking');
    httpMock.verify();
  });

  it('changes a team leader via the inline drop-down (R13.3)', () => {
    const fixture = create([team({ id: 1, teamLeaderId: 10 })]);
    const el = fixture.nativeElement as HTMLElement;
    const select = el.querySelector<HTMLSelectElement>('select.leader-select')!;
    select.value = '11';
    select.dispatchEvent(new Event('change'));

    const req = httpMock.expectOne((r) => r.url === '/api/admin/teams/1' && r.method === 'PATCH');
    expect(req.request.body).toEqual({ teamLeaderId: 11 });
    req.flush(team({ id: 1, teamLeaderId: 11 }));
    fixture.detectChanges();

    // The row now resolves to the new leader's name.
    expect(el.querySelector('.admin-table tbody')?.textContent).toContain('Alan Turing');
    httpMock.verify();
  });

  it('closes a team (R13.3)', () => {
    const fixture = create([team({ id: 1, isClosed: false })]);
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.btn-danger')!.click();

    const req = httpMock.expectOne((r) => r.url === '/api/admin/teams/1' && r.method === 'PATCH');
    expect(req.request.body).toEqual({ isClosed: true });
    req.flush(team({ id: 1, isClosed: true }));
    fixture.detectChanges();

    // State pill flips to Closed and the Close button is gone.
    expect(el.querySelector('.state-pill')?.textContent).toContain('Closed');
    expect(el.querySelector('.btn-danger')).toBeNull();
    httpMock.verify();
  });

  it('surfaces CONFLICT_OPEN_REQUESTS gracefully when a close is blocked (R20.2)', () => {
    const fixture = create([team({ id: 1, isClosed: false })]);
    const el = fixture.nativeElement as HTMLElement;
    el.querySelector<HTMLButtonElement>('.btn-danger')!.click();

    const req = httpMock.expectOne((r) => r.url === '/api/admin/teams/1' && r.method === 'PATCH');
    req.flush(
      {
        error: {
          code: 'CONFLICT_OPEN_REQUESTS',
          message: 'Cannot close a team with non-closed requests.',
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    fixture.detectChanges();

    // A gentle row message is shown, the team stays open, and no crash.
    const message = el.querySelector('.row-message');
    expect(message?.textContent).toContain('open requests');
    expect(el.querySelector('.state-pill')?.textContent).toContain('Open');
    httpMock.verify();
  });

  it('shows an error message when the initial load fails', () => {
    const fixture = TestBed.createComponent(TeamAdmin);
    fixture.detectChanges();
    // forkJoin errors as soon as the teams request fails and cancels the
    // in-flight users request, so only the teams request is flushed here.
    httpMock
      .expectOne((r) => r.url === '/api/admin/teams' && r.method === 'GET')
      .flush('boom', { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    // The screen shows an error banner rather than crashing; the exact text is
    // the mapped ApiError message.
    expect(el.querySelector('.admin-error')).not.toBeNull();
    expect(el.querySelectorAll('.admin-table tbody tr.team-row').length).toBe(0);
  });
});
