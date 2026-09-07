import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { TeamStatistics } from './team-statistics';
import type { TeamStatsResponse } from './team-statistics.service';
import type { TypeSummaryRow } from './user-statistics.service';
import { STATUSES, type Status } from '../support/status-transitions';

/**
 * Component tests for the Team Statistics dashboard (task 13.2; R11, R19). They
 * exercise the behaviours the task calls out: the endpoint load passing the
 * viewer timezone as `?tz` (R11.2 → R18.3), rendering the stacked-bar + two pie
 * charts and the summary table from the TEAM datasets (R11.1 → R10.1–10.5), and
 * the empty state for a leaf manager with no reports (R11.1).
 *
 * The datasets share the User Statistics shape, so the dashboard reuses the
 * exported view-model helpers (covered by the user-statistics spec); these
 * tests focus on the team endpoint, wiring, and empty state.
 */

/** A zeroed count-by-status map with every lifecycle status present. */
function zeroCounts(): Record<Status, number> {
  const out = {} as Record<Status, number>;
  for (const s of STATUSES) {
    out[s] = 0;
  }
  return out;
}

/** Build a summary row with sensible defaults, overridable per test. */
function summaryRow(overrides: Partial<TypeSummaryRow> = {}): TypeSummaryRow {
  return {
    taskId: 1,
    taskName: 'Access Request',
    requestCount: 3,
    countByStatus: { ...zeroCounts(), NEW: 1, TRIAGE: 1, COMPLETE: 1 },
    avgNewToTriageSeconds: 3600,
    avgTriageToCompleteSeconds: 90000,
    ...overrides,
  };
}

/** Build a full team-stats response with sensible defaults, overridable per test. */
function statsResponse(overrides: Partial<TeamStatsResponse> = {}): TeamStatsResponse {
  return {
    timezone: 'UTC',
    statusByMonth: [
      { month: '2026-01', status: 'NEW', count: 5 },
      { month: '2026-01', status: 'COMPLETE', count: 2 },
      { month: '2026-02', status: 'TRIAGE', count: 4 },
    ],
    typeCounts: [
      { taskId: 1, taskName: 'Access Request', count: 6 },
      { taskId: 2, taskName: 'Bug Report', count: 3 },
    ],
    timeByType: [
      { taskId: 1, taskName: 'Access Request', totalMinutes: 240 },
      { taskId: 2, taskName: 'Bug Report', totalMinutes: 60 },
    ],
    summary: [summaryRow()],
    ...overrides,
  };
}

describe('TeamStatistics', () => {
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TeamStatistics],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
  });

  type Comp = TeamStatistics & {
    stats(): TeamStatsResponse | null;
    isEmpty(): boolean;
    monthBars(): unknown[];
    summary(): readonly TypeSummaryRow[];
  };

  /** Create the component and flush the initial team-stats load. */
  function create(body: TeamStatsResponse = statsResponse()) {
    const fixture = TestBed.createComponent(TeamStatistics);
    fixture.detectChanges();
    const req = httpMock.expectOne((r) => r.url === '/api/stats/team');
    // The viewer timezone is always sent as ?tz (R11.2 → R18.3).
    expect(req.request.params.has('tz')).toBe(true);
    expect(req.request.params.get('tz')).toBeTruthy();
    req.flush(body);
    fixture.detectChanges();
    return fixture;
  }

  function comp(fixture: ReturnType<typeof create>): Comp {
    return fixture.componentInstance as unknown as Comp;
  }

  it('loads /api/stats/team with a ?tz timezone on init (R11.2 → R18.3)', () => {
    const fixture = create();
    const c = comp(fixture);
    expect(c.stats()).not.toBeNull();
    httpMock.verify();
  });

  it('renders the stacked-bar and two pie charts from the team datasets (R11 → R10.1–10.3)', () => {
    const fixture = create();
    const el = fixture.nativeElement as HTMLElement;

    // One stacked-bar chart and two pie charts on the page.
    expect(el.querySelectorAll('app-stacked-bar-chart').length).toBe(1);
    expect(el.querySelectorAll('app-pie-chart').length).toBe(2);

    // The stacked bar has one row per distinct month (R10.1).
    const barRows = el.querySelectorAll('app-stacked-bar-chart .bar-row');
    expect(barRows.length).toBe(2); // 2026-01, 2026-02

    // Each pie draws a slice per positive-value task type (R10.2, R10.3).
    const pieSlices = el.querySelectorAll('app-pie-chart .pie-slice');
    expect(pieSlices.length).toBe(4); // 2 slices per pie × 2 pies
    httpMock.verify();
  });

  it('renders the summary table with a row per task type and formatted durations (R10.4, R11.2)', () => {
    const fixture = create(
      statsResponse({
        summary: [
          summaryRow({ taskId: 1, taskName: 'Access Request', avgNewToTriageSeconds: 3600, avgTriageToCompleteSeconds: 90000 }),
          summaryRow({ taskId: 2, taskName: 'Bug Report', avgNewToTriageSeconds: null, avgTriageToCompleteSeconds: null }),
        ],
      }),
    );
    const el = fixture.nativeElement as HTMLElement;

    const bodyRows = el.querySelectorAll('.summary-table tbody tr');
    expect(bodyRows.length).toBe(2);

    // First row: durations rendered as human strings.
    const firstRowText = bodyRows[0].textContent ?? '';
    expect(firstRowText).toContain('Access Request');
    expect(firstRowText).toContain('1h'); // 3600s New→Triage
    expect(firstRowText).toContain('1d 1h'); // 90000s Triage→Complete

    // Second row: null averages render as an em-dash (R11.2 exclusion → none qualify).
    const secondRowText = bodyRows[1].textContent ?? '';
    expect(secondRowText).toContain('Bug Report');
    expect(secondRowText).toContain('—');

    // Header has a column per lifecycle status plus type/count/two durations.
    const headers = el.querySelectorAll('.summary-table thead th');
    expect(headers.length).toBe(STATUSES.length + 4);
    httpMock.verify();
  });

  it('shows an empty state for a leaf manager with no reports (R11.1)', () => {
    const fixture = create(
      statsResponse({ statusByMonth: [], typeCounts: [], timeByType: [], summary: [] }),
    );
    const c = comp(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(c.isEmpty()).toBe(true);
    expect(el.querySelector('.stats-note')?.textContent).toContain('No one reports to you');
    // No charts drawn in the empty state.
    expect(el.querySelectorAll('app-stacked-bar-chart').length).toBe(0);
    expect(el.querySelectorAll('app-pie-chart').length).toBe(0);
    httpMock.verify();
  });

  it('shows an error message when the load fails', () => {
    const fixture = TestBed.createComponent(TeamStatistics);
    fixture.detectChanges();
    const req = httpMock.expectOne((r) => r.url === '/api/stats/team');
    req.flush('boom', { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.stats-error')?.textContent).toContain('Could not load');
    httpMock.verify();
  });
});
