import { runInInjectionContext, Injector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TimezoneService } from '../../core/timezone/timezone.service';
import { LocalDatePipe, toDate } from './local-date.pipe';

/**
 * Build the pipe with a stubbed {@link TimezoneService} so rendering is
 * deterministic regardless of the machine's real timezone.
 */
function pipeForZone(zone: string): LocalDatePipe {
  TestBed.configureTestingModule({
    providers: [{ provide: TimezoneService, useValue: { resolve: () => zone } }],
  });
  const injector = TestBed.inject(Injector);
  return runInInjectionContext(injector, () => new LocalDatePipe());
}

describe('toDate', () => {
  it('parses ISO-8601 strings and epoch millis', () => {
    expect(toDate('2026-02-05T14:30:00.000Z')).toBeInstanceOf(Date);
    expect(toDate(0)).toBeInstanceOf(Date);
    expect(toDate(new Date('2026-02-05T00:00:00Z'))).toBeInstanceOf(Date);
  });

  it('returns null for missing or unparseable input', () => {
    expect(toDate(null)).toBeNull();
    expect(toDate(undefined)).toBeNull();
    expect(toDate('')).toBeNull();
    expect(toDate('   ')).toBeNull();
    expect(toDate('not-a-date')).toBeNull();
    expect(toDate(new Date('nonsense'))).toBeNull();
  });
});

describe('LocalDatePipe', () => {
  const iso = '2026-02-05T14:30:00.000Z'; // 14:30 UTC

  it('renders a UTC instant in the viewer timezone (R18.2)', () => {
    // Tokyo is UTC+9 → 23:30 on the same day.
    const pipe = pipeForZone('Asia/Tokyo');
    expect(pipe.transform(iso, 'datetime')).toBe('05/02/2026, 23:30');
  });

  it('shifts the calendar day when the timezone crosses midnight', () => {
    // New York is UTC-5 in February → 09:30 same day.
    const pipe = pipeForZone('America/New_York');
    expect(pipe.transform(iso, 'datetime')).toBe('05/02/2026, 09:30');
  });

  it('uses en-GB day/month/year ordering for the date format', () => {
    const pipe = pipeForZone('UTC');
    expect(pipe.transform(iso, 'date')).toBe('05/02/2026');
  });

  it('renders 24-hour time for the time format', () => {
    const pipe = pipeForZone('UTC');
    expect(pipe.transform(iso, 'time')).toBe('14:30');
  });

  it('defaults to the date format', () => {
    const pipe = pipeForZone('UTC');
    expect(pipe.transform(iso)).toBe('05/02/2026');
  });

  it('renders null/undefined/empty/invalid input as the fallback', () => {
    const pipe = pipeForZone('UTC');
    expect(pipe.transform(null)).toBe('');
    expect(pipe.transform(undefined)).toBe('');
    expect(pipe.transform('')).toBe('');
    expect(pipe.transform('not-a-date')).toBe('');
  });

  it('honours a custom fallback', () => {
    const pipe = pipeForZone('UTC');
    expect(pipe.transform(null, 'date', '—')).toBe('—');
  });
});
