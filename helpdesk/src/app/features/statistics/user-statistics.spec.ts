import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import {
  UserStatistics,
  formatDurationSeconds,
  toStatusMonthBars,
  toTypeCountSlice,
  toTypeTimeSlice,
} from './user-statistics';
import type {
  StatusMonthBucket,
  TypeSummaryRow,
  UserStatsResponse,
} from './user-statistics.service';
import { STATUSES, type Status } from '../support/status-transitions';

/**
 * Component tests for the User Statistics dashboard (task 13.1; R10). They
 * exercise the behaviours the task calls out: the endpoint load passing the
 * viewer timezone as `?tz` (R18.3), rendering the stacked-bar + two pie charts
 * from the returned datasets (R10.1–10.3), and the summary table with human
 * duration formatting (R10.4, R10.5).
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

/** Build a full stats response with sensible defaults, overridable per test. */
function statsResponse(overrides: Partial<UserStatsResponse> = {}): UserStatsResponse {
  return {
    timezone: 'UTC',
    statusByMonth: [
      { month: '2026-01', status: 'NEW', count: 2 },
      { month: '2026-01', status: 'COMPLETE', count: 1 },
      { month: '2026-02', status: 'TRIAGE', count: 3 },
    ],
    typeCounts: [
      { taskId: 1, taskName: 'Access Request', count: 4 },
      { taskId: 2, taskName: 'Bug Report', count: 2 },
    ],
    timeByType: [
      { taskId: 1, taskName: 'Access Request', totalMinutes: 120 },
      { taskId: 2, taskName: 'Bug Report', totalMinutes: 30 },
    ],
    summary: [summaryRow()],
    ...overrides,
  };
}

describe('UserStatistics', () => {
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [UserStatistics],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
  });

  type Comp = UserStatistics & {
    stats(): UserStatsResponse | null;
    isEmpty(): boolean;
    monthBars(): unknown[];
    typeSlices(): unknown[];
    timeSlices(): unknown[];
    summary(): readonly TypeSummaryRow[];
  };

  /** Create the component and flush the initial stats load. */
  function create(body: UserStatsResponse = statsResponse()) {
    const fixture = TestBed.createComponent(UserStatistics);
    fixture.detectChanges();
    const req = httpMock.expectOne((r) => r.url === '/api/stats/user');
    // The viewer timezone is always sent as ?tz (R18.3).
    expect(req.request.params.has('tz')).toBe(true);
    expect(req.request.params.get('tz')).toBeTruthy();
    req.flush(body);
    fixture.detectChanges();
    return fixture;
  }

  function comp(fixture: ReturnType<typeof create>): Comp {
    return fixture.componentInstance as unknown as Comp;
  }

  it('loads /api/stats/user with a ?tz timezone on init (R18.3)', () => {
    const fixture = create();
    const c = comp(fixture);
    expect(c.stats()).not.toBeNull();
    httpMock.verify();
  });

  it('renders the stacked-bar and two pie charts from the datasets (R10.1–10.3)', () => {
    const fixture = create();
    const el = fixture.nativeElement as HTMLElement;

    // One stacked-bar chart and two pie charts on the page.
    expect(el.querySelectorAll('app-stacked-bar-chart').length).toBe(1);
    expect(el.querySelectorAll('app-pie-chart').length).toBe(2);

    // The stacked bar has one row per distinct month (R10.1).
    const barRows = el.querySelectorAll('app-stacked-bar-chart .bar-row');
    expect(barRows.length).toBe(2); // 2026-01, 2026-02

    // Each pie draws a slice per positive-value task type (R10.2, R10.3).
    const pieSvgs = el.querySelectorAll('app-pie-chart .pie-slice');
    expect(pieSvgs.length).toBe(4); // 2 slices per pie × 2 pies
    httpMock.verify();
  });

  it('renders the summary table with a row per task type and formatted durations (R10.4, R10.5)', () => {
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

    // Second row: null averages render as an em-dash (R10.5 exclusion → none qualify).
    const secondRowText = bodyRows[1].textContent ?? '';
    expect(secondRowText).toContain('Bug Report');
    expect(secondRowText).toContain('—');

    // Header has a column per lifecycle status plus type/count/two durations.
    const headers = el.querySelectorAll('.summary-table thead th');
    expect(headers.length).toBe(STATUSES.length + 4);
    httpMock.verify();
  });

  it('shows an empty state when the user has raised no requests', () => {
    const fixture = create(
      statsResponse({ statusByMonth: [], typeCounts: [], timeByType: [], summary: [] }),
    );
    const c = comp(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(c.isEmpty()).toBe(true);
    expect(el.querySelector('.stats-note')?.textContent).toContain('have not raised any requests');
    httpMock.verify();
  });

  it('shows an error message when the load fails', () => {
    const fixture = TestBed.createComponent(UserStatistics);
    fixture.detectChanges();
    const req = httpMock.expectOne((r) => r.url === '/api/stats/user');
    req.flush('boom', { status: 500, statusText: 'Server Error' });
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.stats-error')?.textContent).toContain('Could not load');
    httpMock.verify();
  });
});

describe('toStatusMonthBars (R10.1)', () => {
  it('groups buckets into one chronological bar per month with status segments', () => {
    const buckets: StatusMonthBucket[] = [
      { month: '2026-02', status: 'TRIAGE', count: 3 },
      { month: '2026-01', status: 'NEW', count: 2 },
      { month: '2026-01', status: 'COMPLETE', count: 1 },
    ];
    const bars = toStatusMonthBars(buckets);
    expect(bars.map((b) => b.label)).toEqual(['2026-01', '2026-02']);
    // 2026-01 has two segments in canonical order (NEW before COMPLETE).
    expect(bars[0].segments.map((s) => s.label)).toEqual(['NEW', 'COMPLETE']);
    expect(bars[0].segments.map((s) => s.value)).toEqual([2, 1]);
    expect(bars[1].segments).toEqual([{ label: 'TRIAGE', value: 3 }]);
  });

  it('returns no bars for an empty dataset', () => {
    expect(toStatusMonthBars([])).toEqual([]);
  });
});

describe('pie slice mappers (R10.2, R10.3)', () => {
  it('maps a type count to a labelled slice', () => {
    expect(toTypeCountSlice({ taskId: 5, taskName: 'Access', count: 7 })).toEqual({
      label: 'Access',
      value: 7,
    });
  });

  it('maps time-by-type to a slice using recorded minutes', () => {
    expect(toTypeTimeSlice({ taskId: 5, taskName: 'Access', totalMinutes: 42 })).toEqual({
      label: 'Access',
      value: 42,
    });
  });
});

describe('formatDurationSeconds (R10.4)', () => {
  it('renders an em-dash for null (no qualifying requests, incl. R10.5 exclusion)', () => {
    expect(formatDurationSeconds(null)).toBe('—');
    expect(formatDurationSeconds(-10)).toBe('—');
  });

  it('formats durations, omitting zero units', () => {
    expect(formatDurationSeconds(0)).toBe('0m');
    expect(formatDurationSeconds(30)).toBe('<1m'); // sub-minute but positive
    expect(formatDurationSeconds(60)).toBe('1m');
    expect(formatDurationSeconds(5400)).toBe('1h 30m');
    expect(formatDurationSeconds(90000)).toBe('1d 1h');
  });
});
