import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import { RequestsList, formatMinutes } from './requests-list';
import type { RequestListRow } from './requests-list.service';

/**
 * Component tests for the user-side Requests list (task 11.1; R4). They exercise
 * the behaviours the task calls out: the initial default query, the My
 * Requests / My Team scope toggle (R4.3), the Hide Complete toggle (R4.4),
 * debounced search (R4.2), the "(Working On)" and "Updated" indicators
 * (R4.6, R4.8), and row navigation to the detail view (task 11.2).
 */

/** Build a request-list row with sensible defaults, overridable per test. */
function row(overrides: Partial<RequestListRow> = {}): RequestListRow {
  return {
    id: 1,
    taskReference: 'REQ-1',
    jiraNumber: null,
    title: 'A request',
    dateRaised: '2026-02-05T09:00:00.000Z',
    status: 'NEW',
    teamId: 1,
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

function listBody(rows: RequestListRow[]) {
  return { scope: 'mine', hideComplete: true, search: null, requests: rows };
}

describe('RequestsList', () => {
  let httpMock: HttpTestingController;
  let router: Router;

  beforeEach(async () => {
    vi.useFakeTimers();
    await TestBed.configureTestingModule({
      imports: [RequestsList],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate').mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  type Comp = RequestsList & {
    scope(): 'mine' | 'team';
    hideComplete(): boolean;
    search(): string;
    rows(): readonly RequestListRow[];
    setScope(scope: 'mine' | 'team'): void;
    toggleHideComplete(): void;
    onSearchInput(value: string): void;
    displayStatus(row: RequestListRow): string;
    isClosed(row: RequestListRow): boolean;
    openRequest(row: RequestListRow): void;
  };

  /** Create the component and flush the initial default load. */
  function create(initial: RequestListRow[] = [row()]) {
    const fixture = TestBed.createComponent(RequestsList);
    fixture.detectChanges();
    const req = httpMock.expectOne((r) => r.url === '/api/requests');
    // Default query: scope=mine, hideComplete=true, no q (R4.3, R4.4).
    expect(req.request.params.get('scope')).toBe('mine');
    expect(req.request.params.get('hideComplete')).toBe('true');
    expect(req.request.params.has('q')).toBe(false);
    req.flush(listBody(initial));
    fixture.detectChanges();
    return fixture;
  }

  function comp(fixture: ReturnType<typeof create>): Comp {
    return fixture.componentInstance as unknown as Comp;
  }

  it('loads with the default scope/hide-complete on init (R4.3, R4.4)', () => {
    const fixture = create();
    const c = comp(fixture);
    expect(c.scope()).toBe('mine');
    expect(c.hideComplete()).toBe(true);
    expect(c.rows().length).toBe(1);
    httpMock.verify();
  });

  it('re-queries with scope=team when switching to My Team (R4.3, R19)', () => {
    const fixture = create();
    const c = comp(fixture);

    c.setScope('team');
    const req = httpMock.expectOne((r) => r.url === '/api/requests');
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
    httpMock.expectNone((r) => r.url === '/api/requests');
    httpMock.verify();
  });

  it('re-queries with hideComplete=false when the toggle is unchecked (R4.4)', () => {
    const fixture = create();
    const c = comp(fixture);

    c.toggleHideComplete();
    const req = httpMock.expectOne((r) => r.url === '/api/requests');
    expect(req.request.params.get('hideComplete')).toBe('false');
    req.flush(listBody([row(), row({ id: 2, status: 'COMPLETE' })]));
    fixture.detectChanges();

    expect(c.hideComplete()).toBe(false);
    expect(c.rows().length).toBe(2);
    httpMock.verify();
  });

  it('debounces search input and sends the term as q (R4.2)', () => {
    const fixture = create();
    const c = comp(fixture);

    // Rapid keystrokes: no request until the debounce elapses.
    c.onSearchInput('acc');
    c.onSearchInput('access');
    httpMock.expectNone((r) => r.url === '/api/requests');

    vi.advanceTimersByTime(300);
    const req = httpMock.expectOne((r) => r.url === '/api/requests');
    expect(req.request.params.get('q')).toBe('access');
    req.flush(listBody([row({ title: 'access request' })]));
    fixture.detectChanges();

    expect(c.search()).toBe('access');
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

  it('renders the "Updated" indicator only when updatedSinceLastSeen is true (R4.8)', () => {
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

  it('navigates to the request detail on row click (task 11.2 route)', () => {
    const fixture = create([row({ id: 42 })]);
    const c = comp(fixture);
    c.openRequest(row({ id: 42 }));
    expect(router.navigate).toHaveBeenCalledWith(['/requests', 42]);
    httpMock.verify();
  });

  it('shows an empty-state message when no requests match', () => {
    const fixture = create([]);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.list-note')?.textContent).toContain('No requests match');
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
