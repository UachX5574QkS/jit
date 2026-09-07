import { TestBed } from '@angular/core/testing';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TeamMembership } from './team-membership';
import type { TeamWithMembersView } from './team-membership.service';
import { CurrentUserService } from '../../core/auth/current-user.service';
import type { CurrentUser, Role } from '../../core/auth/current-user.model';
import { errorInterceptor } from '../../core/http/error.interceptor';

/**
 * Component tests for the Team-Leader Team Membership screen (task 14.2; R15,
 * R20.3). They exercise the behaviours the task calls out: load a team the
 * leader leads, add and remove a member — including the graceful handling of
 * `CONFLICT_OPEN_REQUESTS` when a removal is blocked (R20.3) — and update the
 * team's details (R15.2).
 */

function makeUser(teamsLed: number[], roles: Role[] = ['USER', 'TEAM_LEADER']): CurrentUser {
  return {
    id: 1,
    username: '11111111',
    displayName: 'Team Leader',
    roles: new Set<Role>(roles),
    teamsLed,
    teamsMemberOf: [],
    isAdmin: roles.includes('ADMINISTRATOR'),
    timezone: null,
  };
}

function teamWithMembers(overrides: Partial<TeamWithMembersView> = {}): TeamWithMembersView {
  return {
    team: {
      id: 5,
      title: 'Access Management',
      description: 'Handles access requests',
      teamLeaderId: 1,
      isClosed: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    members: [
      { userId: 20, username: '20000000', displayName: 'Ada Lovelace' },
      { userId: 21, username: '21000000', displayName: 'Alan Turing' },
    ],
    ...overrides,
  };
}

describe('TeamMembership', () => {
  let httpMock: HttpTestingController;
  let currentUser: CurrentUserService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TeamMembership],
      providers: [
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    currentUser = TestBed.inject(CurrentUserService);
  });

  /**
   * Create the component for a leader of a single team (auto-selected), flush
   * the open-teams label read and the initial team load.
   */
  function createForSingleTeam(data: TeamWithMembersView = teamWithMembers()) {
    currentUser.setUser(makeUser([data.team.id]));
    const fixture = TestBed.createComponent(TeamMembership);
    fixture.detectChanges();
    // Picker labelling read (best-effort).
    httpMock
      .expectOne((r) => r.url === '/api/teams' && r.method === 'GET')
      .flush({ teams: [{ id: data.team.id, title: data.team.title, description: null }] });
    // Auto-selected single team → detail load.
    httpMock
      .expectOne(
        (r) => r.url === `/api/team-leader/teams/${data.team.id}` && r.method === 'GET',
      )
      .flush(data);
    fixture.detectChanges();
    return fixture;
  }

  it('loads and lists the members of a team the leader leads (R15.3)', () => {
    const fixture = createForSingleTeam();
    const el = fixture.nativeElement as HTMLElement;
    const rows = el.querySelectorAll('.member-row');
    expect(rows.length).toBe(2);
    expect(el.textContent).toContain('Ada Lovelace');
    expect(el.textContent).toContain('Alan Turing');
    httpMock.verify();
  });

  it('adds a member by user id and refreshes the table (R15.3)', () => {
    const fixture = createForSingleTeam();
    const c = fixture.componentInstance as unknown as {
      addUserId: { set(v: string): void };
      addMember(): void;
    };
    c.addUserId.set('22');
    fixture.detectChanges();
    c.addMember();

    const req = httpMock.expectOne(
      (r) => r.url === '/api/team-leader/teams/5' && r.method === 'PATCH',
    );
    expect(req.request.body).toEqual({ addMemberIds: [22] });
    req.flush(
      teamWithMembers({
        members: [
          { userId: 20, username: '20000000', displayName: 'Ada Lovelace' },
          { userId: 21, username: '21000000', displayName: 'Alan Turing' },
          { userId: 22, username: '22000000', displayName: 'Grace Hopper' },
        ],
      }),
    );
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('.member-row').length).toBe(3);
    expect(el.textContent).toContain('Grace Hopper');
    httpMock.verify();
  });

  it('removes a member (R15.3)', () => {
    const fixture = createForSingleTeam();
    const el = fixture.nativeElement as HTMLElement;
    // Remove the first member (Ada, id 20).
    el.querySelectorAll<HTMLButtonElement>('.member-row .btn-danger')[0].click();

    const req = httpMock.expectOne(
      (r) => r.url === '/api/team-leader/teams/5' && r.method === 'PATCH',
    );
    expect(req.request.body).toEqual({ removeMemberIds: [20] });
    req.flush(
      teamWithMembers({ members: [{ userId: 21, username: '21000000', displayName: 'Alan Turing' }] }),
    );
    fixture.detectChanges();

    expect(el.querySelectorAll('.member-row').length).toBe(1);
    expect(el.textContent).not.toContain('Ada Lovelace');
    httpMock.verify();
  });

  it('surfaces CONFLICT_OPEN_REQUESTS gracefully when a removal is blocked (R15.4/R20.3)', () => {
    const fixture = createForSingleTeam();
    const el = fixture.nativeElement as HTMLElement;
    el.querySelectorAll<HTMLButtonElement>('.member-row .btn-danger')[0].click();

    const req = httpMock.expectOne(
      (r) => r.url === '/api/team-leader/teams/5' && r.method === 'PATCH',
    );
    req.flush(
      {
        error: {
          code: 'CONFLICT_OPEN_REQUESTS',
          message: 'Cannot remove a member with non-closed requests under this team.',
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    fixture.detectChanges();

    // A gentle per-member message is shown; the member stays in the table.
    const message = el.querySelector('.row-message');
    expect(message?.textContent).toContain('open requests');
    expect(el.querySelectorAll('.member-row').length).toBe(2);
    httpMock.verify();
  });

  it('updates the team details, sending only changed fields (R15.2)', () => {
    const fixture = createForSingleTeam();
    const c = fixture.componentInstance as unknown as {
      editTitle: { set(v: string): void };
      saveDetails(): void;
    };
    c.editTitle.set('Identity & Access');
    fixture.detectChanges();
    c.saveDetails();

    const req = httpMock.expectOne(
      (r) => r.url === '/api/team-leader/teams/5' && r.method === 'PATCH',
    );
    // Description was untouched, so only the title is sent.
    expect(req.request.body).toEqual({ title: 'Identity & Access' });
    req.flush(
      teamWithMembers({
        team: { ...teamWithMembers().team, title: 'Identity & Access' },
      }),
    );
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.form-success')).not.toBeNull();
    httpMock.verify();
  });

  it('surfaces FORBIDDEN gracefully when the team cannot be managed (R15)', () => {
    currentUser.setUser(makeUser([9]));
    const fixture = TestBed.createComponent(TeamMembership);
    fixture.detectChanges();
    httpMock
      .expectOne((r) => r.url === '/api/teams' && r.method === 'GET')
      .flush({ teams: [{ id: 9, title: 'Networking', description: null }] });
    httpMock
      .expectOne((r) => r.url === '/api/team-leader/teams/9' && r.method === 'GET')
      .flush(
        { error: { code: 'FORBIDDEN', message: 'Requires leadership of this team' } },
        { status: 403, statusText: 'Forbidden' },
      );
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.admin-error')?.textContent).toContain('team you lead');
    httpMock.verify();
  });

  it('shows no-teams messaging when the user leads nothing', () => {
    currentUser.setUser(makeUser([]));
    const fixture = TestBed.createComponent(TeamMembership);
    fixture.detectChanges();
    // Still performs the (empty) picker labelling read.
    httpMock.expectOne((r) => r.url === '/api/teams' && r.method === 'GET').flush({ teams: [] });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('do not lead any teams');
    httpMock.verify();
  });
});
