/**
 * Timer duration helpers for the Support detail view (R8.4, R8.5).
 *
 * The backend keeps recorded durations in whole minutes (the DB stores a
 * minimum of 1 minute); the "Back to Queue" pop-up presents the elapsed time as
 * days, hours and minutes (R8.4) and lets the member keep or edit it before
 * confirming (R8.5). These pure helpers are the single place those two
 * representations are derived, so the component and its tests share one rule.
 */

/** Whole-minute floor of the minimum recordable slice (the DB CHECK, R8.4). */
export const MIN_SLICE_MINUTES = 1;

/**
 * The elapsed whole minutes between an ISO `startedAt` and `now` (defaults to
 * the current time). Rounded to the nearest minute and floored at
 * {@link MIN_SLICE_MINUTES} so a just-started timer still reads as ≥ 1 minute,
 * matching the server's elapsed calculation (R8.4). Returns
 * {@link MIN_SLICE_MINUTES} for an unparseable/empty `startedAt`.
 */
export function elapsedMinutesSince(startedAt: string, now: number = Date.now()): number {
  const startMs = Date.parse(startedAt);
  if (Number.isNaN(startMs)) {
    return MIN_SLICE_MINUTES;
  }
  const minutes = Math.round((now - startMs) / 60_000);
  return Math.max(MIN_SLICE_MINUTES, minutes);
}

/** A duration split into whole days, hours and minutes (R8.4). */
export interface DurationParts {
  readonly days: number;
  readonly hours: number;
  readonly minutes: number;
}

/** Split a whole-minute total into days / hours / minutes (R8.4). */
export function toDurationParts(totalMinutes: number): DurationParts {
  const safe = Math.max(0, Math.floor(totalMinutes));
  const days = Math.floor(safe / (24 * 60));
  const hours = Math.floor((safe % (24 * 60)) / 60);
  const minutes = safe % 60;
  return { days, hours, minutes };
}

/**
 * A human-readable "Xd Yh Zm" summary of a whole-minute total (R8.4), dropping
 * zero-valued leading units. Always shows minutes so a sub-hour duration still
 * reads sensibly (e.g. "3m", "2h 5m", "1d 0h 30m").
 */
export function formatDuration(totalMinutes: number): string {
  const { days, hours, minutes } = toDurationParts(totalMinutes);
  const parts: string[] = [];
  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (days > 0 || hours > 0) {
    parts.push(`${hours}h`);
  }
  parts.push(`${minutes}m`);
  return parts.join(' ');
}
