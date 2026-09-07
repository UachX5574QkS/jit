import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { CurrentUserService } from '../../core/auth/current-user.service';
import { SupportQueue, formatMinutes, type TeamOption } from './support-queue';
import type { SupportQueueRow } from './support-queue.service';

/**
 * Component tests for the Support queue (task 12.1; R6). They exercise the
 * behaviours the task calls out: the initial default query, the team drop-down
 * scoped to the user's memberships (R6.3), the My Queue / Team Queue toggle
 * (R6.4), the Hide Complete (R6.5) and Show Unassigned (R6.6) toggles, debounced
 * search (R6.2), the "(Working On)"/"Updated" indicators (R4.6, R7.5–7.6), and
 * row navigation to the support detail view (task 12.2).
 */

/** Build a queue row with sensible defaults, overridable per test. */
function row(overrides: Partial<SupportQueueRow> = {}): SupportQueueRow {
  return {
    id: 1,
    taskReference: 'REQ-1',
    jiraNumber: null,
    title: 'A request',
    dateRaised: '2026-02-05T09:00:00.000Z',
    status: 'NEW',
    teamId: 7,
    teamTitle: 'Platform',
    assignedMemberId: null,
    assignedMemberName: null,
    lastUpdated: '2026-02-05T10:00:00.000Z',
    estimatedStartDate: null,
    actualStartDate: null,
    hasOpenTimer: false,
    estimatedEffortMinutes: null,
    updatedSinceLastSeen: false,
    ...overrides,
  };
}

function listBody(rows: SupportQueueRow[]) {
  return {
    team: 'all',
    scope: 'mine',
    hideComplete: true,
    showUnassigned: true,
    search: null,
    requests: rows,
  };
}

describe('SupportQueue', () => {
  let httpMock: HttpTestingController;
  let router: Router;
  let currentUser: CurrentUserService;

  beforeEach(async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({
      imports: [SupportQueue],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    currentUser = TestBed.inject(CurrentUserService);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  type Comp = SupportQueue & {
    team(): 'all' | number;
    scope(): 'mine' | 'team';
    hideComplete(): boolean;
    showUnassigned(): boolean;
    search(): string;
    rows(): readonly SupportQueueRow[];
    teamOptions(): readonly TeamOption[];
    onTeamChange(value: string): void;
    setScope(scope: 'mine' | 'team'): void;
    toggleHideComplete(): void;
    toggleShowUnassigned(): void;
    onSearchInput(value: string): void;
    displayStatus(row: SupportQueueRow): string;
    isClosed(row: SupportQueueRow): boolean;
    openRequest(row: SupportQueueRow): void;
  };

  /** Seed the current user's team memberships before the component reads them. */
  function seedUser(teamsMemberOf: number[]) {
    currentUser.setUser({
      id: 100,
      username: '10000000',
      displayName: 'Sam Support',
      roles: new Set(['USER', 'SUPPORT_MEMBER']),
      teamsLed: [],
      teamsMemberOf,
      isAdmin: false,
      timezone: null,
    });
  }

  /** Create the component and flush the initial default load. */
  function create(initial: SupportQueueRow[] = [row()], teamsMemberOf: number[] = [7, 8]) {
    seedUser(teamsMemberOf);
    const fixture = TestBed.createComponent(SupportQueue);
    fixture.detectChanges();
    const req = httpMock.expectOne((r) => r.url === '/api/support/requests');
    // Default query: team=all, scope=mine, hideComplete=true, showUnassigned=true, no q.
    expect(req.request.params.get('team')).toBe('all');
    expect(req.request.params.get('scope')).toBe('mine');
    expect(req.request.params.get('hideComplete')).toBe('true');
    expect(req.request.params.get('showUnassigned')).toBe('true');
    expect(req.request.params.has('q')).toBe(false);
    req.flush(listBody(initial));
    fixture.detectChanges();
    return fixture;
  }

  function comp(fixture: ReturnType<typeof create>): Comp {
    return fixture.componentInstance as unknown as Comp;
  }

  it('loads with the default team/scope/filters on init (R6.3–6.6)', () => {
    const fixture = create();
    const c = comp(fixture);
    expect(c.team()).toBe('all');
    expect(c.scope()).toBe('mine');
    expect(c.hideComplete()).toBe(true);
    expect(c.showUnassigned()).toBe(true);
    expect(c.rows().length).toBe(1);
    httpMock.verify();
  });

  it('scopes the team drop-down to the user memberships plus All Teams (R6.3)', () => {
    const fixture = create([row()], [7, 8]);
    const c = comp(fixture);
    const opts = c.teamOptions();
    // "All Teams" first, then one entry per team the user belongs to.
    expect(opts[0]).toEqual({ value: 'all', label: 'All Teams' });
    expect(opts.map((o) => o.value)).toEqual(['all', 7, 8]);
    // Team 7's label came from the returned row's teamTitle; 8 has no row yet.
    expect(opts.find((o) => o.value === 7)?.label).toBe('Platform');
    expect(opts.find((o) => o.value === 8)?.label).toBe('Team #8');
    httpMock.verify();
  });

  it('re-queries with a specific team when the drop-down changes (R6.3)', () => {
    const fixture = create();
    const c = comp(fixture);

    c.onTeamChange('8');
    const req = httpMock.expectOne((r) => r.url === '/api/support/requests');
    expect(req.request.params.get('team')).toBe('8');
    req.flush(listBody([row({ id: 9, teamId: 8, teamTitle: 'Access' })]));
    fixture.detectChanges();

    expect(c.team()).toBe(8);
    // The label cache now knows team 8's title.
    expect(c.teamOptions().find((o) => o.value === 8)?.label).toBe('Access');
    httpMock.verify();
  });

  it('re-queries with scope=team when switching to Team Queue (R6.4)', () => {
    const fixture = create();
    const c = comp(fixture);

    c.setScope('team');
    const req = httpMock.expectOne((r) => r.url === '/api/support/requests');
    expect(req.request.params.get('scope')).toBe('team');
    req.flush(listBody([row({ id: 7, taskReference: 'REQ-7' })]));
    fixture.detectChanges();

    expect(c.scope()).toBe('team');
    expect(c.rows()[0].taskReference).toBe('REQ-7');
    httpMock.verify();
  });

  it('does not re-query when the scope is unchanged', () => {
    const fixture = create();
    const c = comp(fixture);
    c.setScope('mine'); // already mine
    httpMock.expectNone((r) => r.url === '/api/support/requests');
    httpMock.verify();
  });

  it('re-queries with hideComplete=false when the toggle is unchecked (R6.5)', () => {
    const fixture = create();
    const c = comp(fixture);

    c.toggleHideComplete();
    const req = httpMock.expectOne((r) => r.url === '/api/support/requests');
    expect(req.request.params.get('hideComplete')).toBe('false');
    req.flush(listBody([row(), row({ id: 2, status: 'COMPLETE' })]));
    fixture.detectChanges();

    expect(c.hideComplete()).toBe(false);
    expect(c.rows().length).toBe(2);
    httpMock.verify();
  });

  it('re-queries with showUnassigned=false when the toggle is unchecked (R6.6)', () => {
    const fixture = create();
    const c = comp(fixture);

    c.toggleShowUnassigned();
    const req = httpMock.expectOne((r) => r.url === '/api/support/requests');
    expect(req.request.params.get('showUnassigned')).toBe('false');
    req.flush(listBody([row({ assignedMemberId: 100, assignedMemberName: 'Sam Support' })]));
    fixture.detectChanges();

    expect(c.showUnassigned()).toBe(false);
    httpMock.verify();
  });

  it('debounces search input and sends the term as q (R6.2)', () => {
    const fixture = create();
    const c = comp(fixture);

    // Rapid keystrokes: no request until the debounce elapses.
    c.onSearchInput('tone');
    c.onSearchInput('toner');
    httpMock.expectNone((r) => r.url === '/api/support/requests');

    vi.advanceTimersByTime(300);
    const req = httpMock.expectOne((r) => r.url === '/api/support/requests');
    expect(req.request.params.get('q')).toBe('toner');
    req.flush(listBody([row({ title: 'toner order' })]));
    fixture.detectChanges();

    expect(c.search()).toBe('toner');
    httpMock.verify();
  });

  it('appends " (Working On)" to a non-closed request with an open timer (R4.6)', () => {
    const fixture = create();
    const c = comp(fixture);

    const active = row({ status: 'ACTIVE', hasOpenTimer: true });
    expect(c.displayStatus(active)).toBe('ACTIVE (Working On)');

    // A closed request never shows the suffix even if a timer flag lingers.
    const complete = row({ status: 'COMPLETE', hasOpenTimer: true });
    expect(c.displayStatus(complete)).toBe('COMPLETE');
    expect(c.isClosed(complete)).toBe(true);
    httpMock.verify();
  });

  it('renders the "Updated" indicator only when updatedSinceLastSeen is true (R7.5–7.6)', () => {
    const fixture = create([
      row({ id: 1, updatedSinceLastSeen: true }),
      row({ id: 2, updatedSinceLastSeen: false }),
    ]);
    const el = fixture.nativeElement as HTMLElement;
    const pills = el.querySelectorAll('.updated-pill');
    expect(pills.length).toBe(1);
    expect(pills[0].textContent?.trim()).toBe('Updated');
    httpMock.verify();
  });

  it('navigates to the support detail on row click (task 12.2 route)', () => {
    const fixture = create([row({ id: 42 })]);
    const c = comp(fixture);
    c.openRequest(row({ id: 42 }));
    expect(router.navigate).toHaveBeenCalledWith(['/support', 42]);
    httpMock.verify();
  });

  it('shows an empty-state message when no requests match', () => {
    const fixture = create([]);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.list-note')?.textContent).toContain('No requests match');
    httpMock.verify();
  });

  it('offers only All Teams when the user belongs to no teams', () => {
    const fixture = create([], []);
    const c = comp(fixture);
    expect(c.teamOptions()).toEqual([{ value: 'all', label: 'All Teams' }]);
    httpMock.verify();
  });
});

describe('formatMinutes (Estimated Effort, R4.7)', () => {
  it('renders an em-dash for null (no complete requests yet)', () => {
    expect(formatMinutes(null)).toBe('—');
    expect(formatMinutes(-5)).toBe('—');
  });

  it('formats whole-minute durations, omitting zero units', () => {
    expect(formatMinutes(0)).toBe('0m');
    expect(formatMinutes(45)).toBe('45m');
    expect(formatMinutes(90)).toBe('1h 30m');
    expect(formatMinutes(60 * 24 + 60)).toBe('1d 1h');
    expect(formatMinutes(59.6)).toBe('1h'); // rounds to 60
  });
});
