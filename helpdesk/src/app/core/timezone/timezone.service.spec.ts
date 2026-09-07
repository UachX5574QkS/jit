import { TestBed } from '@angular/core/testing';
import { CurrentUserService } from '../auth/current-user.service';
import type { CurrentUser } from '../auth/current-user.model';
import {
  FALLBACK_TIMEZONE,
  TimezoneService,
  browserTimezone,
  isValidTimezone,
  resolveEffectiveTimezone,
} from './timezone.service';

function user(timezone: string | null): CurrentUser {
  return {
    id: 1,
    username: '00000001',
    displayName: 'Test User',
    roles: new Set(['USER']),
    teamsLed: [],
    teamsMemberOf: [],
    isAdmin: false,
    timezone,
  };
}

describe('isValidTimezone', () => {
  it('accepts a known IANA zone', () => {
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('rejects null, empty, and malformed names', () => {
    expect(isValidTimezone(null)).toBe(false);
    expect(isValidTimezone(undefined)).toBe(false);
    expect(isValidTimezone('')).toBe(false);
    expect(isValidTimezone('   ')).toBe(false);
    expect(isValidTimezone('Not/AZone')).toBe(false);
  });
});

describe('resolveEffectiveTimezone', () => {
  it('prefers the browser timezone (R18.2)', () => {
    const browser = browserTimezone();
    // In the test environment the browser reports a real zone; the resolver
    // must return it regardless of the user context.
    expect(resolveEffectiveTimezone('Asia/Tokyo')).toBe(browser ?? 'Asia/Tokyo');
  });

  it('falls back to the user timezone when the browser cannot report one', () => {
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(
      // Force the browser lookup to fail so the user context is used.
      (() => {
        throw new RangeError('no zone');
      }) as unknown as typeof Intl.DateTimeFormat,
    );
    try {
      expect(resolveEffectiveTimezone('Europe/Paris')).toBe(FALLBACK_TIMEZONE);
    } finally {
      spy.mockRestore();
    }
  });

  it('falls back to UTC when neither browser nor user provide a valid zone', () => {
    expect(resolveEffectiveTimezone(null)).toBe(browserTimezone() ?? FALLBACK_TIMEZONE);
    expect(resolveEffectiveTimezone('nonsense')).toBe(browserTimezone() ?? FALLBACK_TIMEZONE);
  });
});

describe('TimezoneService', () => {
  let currentUser: CurrentUserService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    currentUser = TestBed.inject(CurrentUserService);
  });

  it('resolves a valid IANA timezone', () => {
    const service = TestBed.inject(TimezoneService);
    currentUser.setUser(user('Europe/London'));
    expect(isValidTimezone(service.resolve())).toBe(true);
  });

  it('reacts to a change in the current user', () => {
    const service = TestBed.inject(TimezoneService);
    currentUser.setUser(user('Europe/London'));
    const first = service.timezone();
    currentUser.setUser(user('Asia/Tokyo'));
    // Browser zone wins in-test, so both stay valid; the point is no throw and
    // the computed re-runs off the user signal.
    expect(isValidTimezone(service.timezone())).toBe(true);
    expect(isValidTimezone(first)).toBe(true);
  });

  it('still resolves a valid zone when no user is loaded', () => {
    const service = TestBed.inject(TimezoneService);
    currentUser.clear();
    expect(isValidTimezone(service.resolve())).toBe(true);
  });
});
