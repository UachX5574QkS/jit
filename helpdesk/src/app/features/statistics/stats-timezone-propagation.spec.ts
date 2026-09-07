import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TimezoneService } from '../../core/timezone/timezone.service';
import { UserStatisticsService } from './user-statistics.service';
import { TeamStatisticsService } from './team-statistics.service';
import { SupportStatisticsService } from './support-statistics.service';

/**
 * END-TO-END (frontend half) verification of R18.3 `?tz` propagation (task
 * 16.3). The three statistics services must send the viewer's EFFECTIVE
 * timezone — the exact value {@link TimezoneService.resolve} returns — as the
 * `?tz` query parameter, so the backend's `AT TIME ZONE $tz` month bucketing
 * (proven end-to-end against the live DB in
 * `backend/.../stats-timezone-bucketing.e2e.test.ts`) is computed in the SAME
 * zone the `LocalDatePipe` renders dates in on the same screen (R18.2/R18.3).
 *
 * The dashboards' own specs already assert `?tz` is PRESENT; these tests
 * tighten that to "`?tz` EQUALS `TimezoneService.resolve()`" by stubbing the
 * service with a DISTINCTIVE, non-default zone and asserting the outgoing
 * parameter matches it exactly. `TimezoneService.resolve()` itself (browser →
 * user → UTC resolution, R18.2) is unit-tested in `timezone.service.spec.ts`,
 * and the UTC-instant-in-viewer-zone rendering in `local-date.pipe.spec.ts`.
 */

// A distinctive zone unlikely to be the test machine's default, so a spec that
// merely echoed the ambient zone could not pass by accident.
const STUB_ZONE = 'Pacific/Kiritimati'; // UTC+14

/** A TimezoneService stub whose resolve() returns the distinctive zone. */
const stubTimezone: Pick<TimezoneService, 'resolve'> = {
  resolve: () => STUB_ZONE,
};

describe('Statistics services — ?tz propagation from TimezoneService.resolve() (R18.3)', () => {
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: TimezoneService, useValue: stubTimezone },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('UserStatisticsService.getUserStats sends ?tz equal to TimezoneService.resolve()', () => {
    const service = TestBed.inject(UserStatisticsService);
    service.getUserStats().subscribe();

    const req = httpMock.expectOne((r) => r.url === '/api/stats/user');
    expect(req.request.params.get('tz')).toBe(STUB_ZONE);
    req.flush({
      timezone: STUB_ZONE,
      statusByMonth: [],
      typeCounts: [],
      timeByType: [],
      summary: [],
    });
  });

  it('TeamStatisticsService.getTeamStats sends ?tz equal to TimezoneService.resolve()', () => {
    const service = TestBed.inject(TeamStatisticsService);
    service.getTeamStats().subscribe();

    const req = httpMock.expectOne((r) => r.url === '/api/stats/team');
    expect(req.request.params.get('tz')).toBe(STUB_ZONE);
    req.flush({
      timezone: STUB_ZONE,
      statusByMonth: [],
      typeCounts: [],
      timeByType: [],
      summary: [],
    });
  });

  it('SupportStatisticsService.getSupportStats sends ?tz equal to TimezoneService.resolve() (with ?team)', () => {
    const service = TestBed.inject(SupportStatisticsService);
    service.getSupportStats('all').subscribe();

    const req = httpMock.expectOne((r) => r.url === '/api/stats/support');
    expect(req.request.params.get('tz')).toBe(STUB_ZONE);
    // The team selection travels alongside the timezone (R12.1); both are sent.
    expect(req.request.params.get('team')).toBe('all');
    req.flush({
      team: 'all',
      statusByMonth: [],
      members: [],
      rows: [],
      assignedCounts: [],
      avgAcceptedToComplete: [],
    });
  });
});
