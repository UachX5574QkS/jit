import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { SupportStatistics } from './support-statistics';
import type { SupportStatsResponse } from './support-statistics.service';
import { CurrentUserService } from '../../core/auth/current-user.service';
import type { CurrentUser } from '../../core/auth/current-user.model';

/**
 * Component tests for the Support Statistics dashboard (task 13.3; R12). They
 * exercise the behaviours the task calls out:
 *   • the team drop-down (incl. "All Teams") re-querying with `?team` (R12.1);
 *   • the viewer timezone travelling as `?tz` (R12.2 → R18.3);
 *   • the status-by-month stacked bar rendering from the buckets (R12.2);
 *   • the assigned-count matrix (rows × members) rendering the dense grid (R12.3);
 *   • the Accepted→Complete matrix with human-formatted / null durations (R12.4).
 */

/** A support member belonging to teams 10 and 20 (drives the drop-down, R12.1). */
function supportUser(): CurrentUser {
  return {
    id: 1,
    username: 'sam.support',
    displayName: 'Sam Support',
    roles: new Set(['USER', 'SUPPORT_MEMBER']),
    teamsLed: [],
    teamsMemberOf: [10, 20],
    isAdmin: false,
    timezone: null,
  };
}

/** A full support-stats response with sensible defaults, overridable per test. */
function statsResponse(overrides: Partial<SupportStatsResponse> = {}): SupportStatsResponse {
  return {
    team: 'all',
    timezone: 'UTC',
    statusByMonth: [
      { month: '2026-01', status: 'NEW', count: 5 },
      { month: '2026-01', status: 'COMPLETE', count: 2 },
      { month: '2026-02', status: 'TRIAGE', count: 4 },
    ],
    members: [
      { memberId: 100, memberName: 'Alice Adams' },
      { memberId: 200, memberName: 'Bob Brown' },
    ],
    rows: [
      { taskId: 1, taskName: 'Access Request', teamId: 10, teamTitle: 'Team A', label: 'Team A - Access Request' },
      { taskId: 2, taskName: 'Bug Report', teamId: 20, teamTitle: 'Team B', label: 'Team B - Bug Report' },
    ],
    // Dense (rows × members) grids, as the backend serialises them.
    assignedCounts: [
      { taskId: 1, memberId: 100, count: 3 },
      { taskId: 1, memberId: 200, count: 0 },
      { taskId: 2, memberId: 100, count: 1 },
      { taskId: 2, memberId: 200, count: 4 },
    ],
    avgAcceptedToComplete: [
      { taskId: 1, memberId: 100, avgAcceptedToCompleteSeconds: 90000 }, // 1d 1h
      { taskId: 1, memberId: 200, avgAcceptedToCompleteSeconds: null }, // em-dash
      { taskId: 2, memberId: 100, avgAcceptedToCompleteSeconds: 3600 }, // 1h
      { taskId: 2, memberId: 200, avgAcceptedToCompleteSeconds: null },
    ],
    ...overrides,
  };
}

describe('SupportStatistics', () => {
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [SupportStatistics],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    // Seed the current user so the drop-down lists the user's teams (R12.1).
    TestBed.inject(CurrentUserService).setUser(supportUser());
  });

  /** Create the component and flush the initial (All Teams) load. */
  function create(body: SupportStatsResponse = statsResponse()) {
    const fixture = TestBed.createComponent(SupportStatistics);
    fixture.detectChanges();
    const req = httpMock.expectOne((r) => r.url === '/api/stats/support');
    // Defaults to "all" and always sends the viewer timezone (R12.1, R12.2).
    expect(req.request.params.get('team')).toBe('all');
    expect(req.request.params.has('tz')).toBe(true);
    expect(req.request.params.get('tz')).toBeTruthy();
    req.flush(body);
    fixture.detectChanges();
    return fixture;
  }

  it('loads /api/stats/support with team=all and a ?tz timezone on init (R12.1, R12.2 → R18.3)', () => {
    create();
    httpMock.verify();
  });

  it('lists the user\'s teams plus "All Teams" in the drop-down (R12.1)', () => {
    const fixture = create();
    const el = fixture.nativeElement as HTMLElement;
    const options = el.querySelectorAll('.team-select option');
    // "All Teams" + one per team the user belongs to (10, 20).
    expect(options.length).toBe(3);
    expect(options[0].textContent).toContain('All Teams');
    // The team titles are picked up from the response rows.
    const labels = Array.from(options).map((o) => o.textContent?.trim());
    expect(labels).toContain('Team A');
    expect(labels).toContain('Team B');
    httpMock.verify();
  });

  it('re-queries with ?team when the drop-down changes to a specific team (R12.1)', () => {
    const fixture = create();
    const el = fixture.nativeElement as HTMLElement;
    const select = el.querySelector('.team-select') as HTMLSelectElement;

    select.value = '10';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    const req = httpMock.expectOne((r) => r.url === '/api/stats/support');
    expect(req.request.params.get('team')).toBe('10');
    expect(req.request.params.has('tz')).toBe(true);
    req.flush(
      statsResponse({
        team: 10,
        rows: [
          { taskId: 1, taskName: 'Access Request', teamId: 10, teamTitle: 'Team A', label: 'Access Request' },
        ],
      }),
    );
    fixture.detectChanges();
    httpMock.verify();
  });

  it('re-queries with team=all when switched back to All Teams (R12.1)', () => {
    const fixture = create();
    const el = fixture.nativeElement as HTMLElement;
    const select = el.querySelector('.team-select') as HTMLSelectElement;

    // Move away from "all" first…
    select.value = '10';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    httpMock.expectOne((r) => r.url === '/api/stats/support').flush(statsResponse({ team: 10 }));
    fixture.detectChanges();

    // …then back to "All Teams".
    select.value = 'all';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    const req = httpMock.expectOne((r) => r.url === '/api/stats/support');
    expect(req.request.params.get('team')).toBe('all');
    req.flush(statsResponse());
    fixture.detectChanges();
    httpMock.verify();
  });

  it('renders the status-by-month stacked bar from the buckets (R12.2)', () => {
    const fixture = create();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('app-stacked-bar-chart').length).toBe(1);
    // One bar per distinct month (2026-01, 2026-02).
    const barRows = el.querySelectorAll('app-stacked-bar-chart .bar-row');
    expect(barRows.length).toBe(2);
    httpMock.verify();
  });

  it('renders the assigned-count matrix: rows × member columns with each cell count (R12.3)', () => {
    const fixture = create();
    const el = fixture.nativeElement as HTMLElement;
    const table = el.querySelectorAll('.matrix-table')[0] as HTMLTableElement;

    // Header: a "Task" column plus one column per member.
    const headers = table.querySelectorAll('thead th');
    expect(headers.length).toBe(1 + 2);
    expect(headers[1].textContent).toContain('Alice Adams');
    expect(headers[2].textContent).toContain('Bob Brown');

    // One body row per task type, with "Team - Task" labels across teams.
    const bodyRows = table.querySelectorAll('tbody tr');
    expect(bodyRows.length).toBe(2);
    expect(bodyRows[0].textContent).toContain('Team A - Access Request');

    // Cells: task 1 → Alice=3, Bob=0.
    const row0Cells = bodyRows[0].querySelectorAll('td');
    expect(row0Cells[0].textContent?.trim()).toBe('3');
    expect(row0Cells[1].textContent?.trim()).toBe('0');
    // Cells: task 2 → Alice=1, Bob=4.
    const row1Cells = bodyRows[1].querySelectorAll('td');
    expect(row1Cells[0].textContent?.trim()).toBe('1');
    expect(row1Cells[1].textContent?.trim()).toBe('4');
    httpMock.verify();
  });

  it('renders the Accepted→Complete matrix with formatted durations and em-dash for null (R12.4)', () => {
    const fixture = create();
    const el = fixture.nativeElement as HTMLElement;
    const table = el.querySelectorAll('.matrix-table')[1] as HTMLTableElement;

    const bodyRows = table.querySelectorAll('tbody tr');
    expect(bodyRows.length).toBe(2);

    // Task 1: Alice 90000s → "1d 1h", Bob null → em-dash.
    const row0Cells = bodyRows[0].querySelectorAll('td');
    expect(row0Cells[0].textContent?.trim()).toBe('1d 1h');
    expect(row0Cells[1].textContent?.trim()).toBe('—');

    // Task 2: Alice 3600s → "1h", Bob null → em-dash.
    const row1Cells = bodyRows[1].querySelectorAll('td');
    expect(row1Cells[0].textContent?.trim()).toBe('1h');
    expect(row1Cells[1].textContent?.trim()).toBe('—');
    httpMock.verify();
  });

  it('uses the bare task name as the row label when a single team is in scope (R12.3)', () => {
    const fixture = create(
      statsResponse({
        team: 10,
        rows: [
          { taskId: 1, taskName: 'Access Request', teamId: 10, teamTitle: 'Team A', label: 'Access Request' },
        ],
        members: [{ memberId: 100, memberName: 'Alice Adams' }],
        assignedCounts: [{ taskId: 1, memberId: 100, count: 2 }],
        avgAcceptedToComplete: [{ taskId: 1, memberId: 100, avgAcceptedToCompleteSeconds: null }],
      }),
    );
    const el = fixture.nativeElement as HTMLElement;
    const firstRowHeader = el.querySelector('.matrix-table tbody tr th');
    expect(firstRowHeader?.textContent?.trim()).toBe('Access Request');
    httpMock.verify();
  });

  it('shows an empty state when there is no support activity in scope (R12.1)', () => {
    const fixture = create(
      statsResponse({ statusByMonth: [], members: [], rows: [], assignedCounts: [], avgAcceptedToComplete: [] }),
    );
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.stats-note')?.textContent).toContain('no support activity');
    expect(el.querySelectorAll('app-stacked-bar-chart').length).toBe(0);
    expect(el.querySelectorAll('.matrix-table').length).toBe(0);
    httpMock.verify();
  });

  it('shows an error message when the load fails', () => {
    const fixture = TestBed.createComponent(SupportStatistics);
    fixture.detectChanges();
    const req = httpMock.expectOne((r) => r.url === '/api/stats/support');
    req.flush('boom', { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.stats-error')?.textContent).toContain('Could not load');
    httpMock.verify();
  });
});
