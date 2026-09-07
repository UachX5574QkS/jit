import { Pipe, PipeTransform, inject } from '@angular/core';
import { TimezoneService } from '../../core/timezone/timezone.service';

/**
 * The supported render formats. Kept small and intention-revealing rather than
 * exposing raw `Intl` options at call sites:
 *   • `date`     — day/month/year, e.g. "05/02/2026".
 *   • `datetime` — date plus 24-hour time, e.g. "05/02/2026, 14:30".
 *   • `time`     — 24-hour time only, e.g. "14:30".
 */
export type LocalDateFormat = 'date' | 'datetime' | 'time';

const FORMAT_OPTIONS: Record<LocalDateFormat, Intl.DateTimeFormatOptions> = {
  date: { day: '2-digit', month: '2-digit', year: 'numeric' },
  datetime: {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  },
  time: { hour: '2-digit', minute: '2-digit', hour12: false },
};

/**
 * Renders a backend ISO-8601 timestamp in the viewer's browser-local timezone
 * using UK English (en-GB) formatting (design: "Timezone", R18.2; workspace UI
 * spec "UK English (en-GB) only").
 *
 * ── Why a dedicated pipe (not Angular's `DatePipe`) ──────────────────────────
 * The backend returns instants in ISO-8601 (UTC). This pipe formats them with
 * `Intl.DateTimeFormat`, pinned to `en-GB` and to the effective timezone from
 * {@link TimezoneService} — the viewer's browser zone, per R18.2 — so every
 * screen shows the same locally-correct value without each caller registering a
 * locale or juggling timezone offsets.
 *
 * ── Graceful input handling ──────────────────────────────────────────────────
 * `null`, `undefined`, empty strings, and unparseable values render as the
 * `fallback` (default `''`) rather than throwing or showing "Invalid Date", so
 * a missing timestamp (e.g. a not-yet-completed request) is simply blank.
 *
 * Usage:
 *   {{ request.createdAt | localDate }}            → "05/02/2026"
 *   {{ request.createdAt | localDate:'datetime' }} → "05/02/2026, 14:30"
 *   {{ request.completedAt | localDate:'date':'—' }}
 */
@Pipe({ name: 'localDate' })
export class LocalDatePipe implements PipeTransform {
  private readonly timezone = inject(TimezoneService);

  transform(
    value: string | number | Date | null | undefined,
    format: LocalDateFormat = 'date',
    fallback = '',
  ): string {
    const date = toDate(value);
    if (date === null) {
      return fallback;
    }

    const options: Intl.DateTimeFormatOptions = {
      ...(FORMAT_OPTIONS[format] ?? FORMAT_OPTIONS.date),
      timeZone: this.timezone.resolve(),
    };

    try {
      return new Intl.DateTimeFormat('en-GB', options).format(date);
    } catch {
      // A resolved-yet-unusable timezone is highly unlikely (the service
      // validates it), but never let a formatting error surface to the user.
      return fallback;
    }
  }
}

/**
 * Coerce an ISO string / epoch millis / `Date` into a valid `Date`, or `null`
 * for missing or unparseable input. Exported for direct unit testing.
 */
export function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
