import { Injectable, computed, inject } from '@angular/core';
import { CurrentUserService } from '../auth/current-user.service';

/** Safe last-resort timezone when neither the browser nor the user provide one. */
export const FALLBACK_TIMEZONE = 'UTC';

/**
 * Resolves the timezone used to render dates and to bucket statistics "by
 * month" (design: "Timezone", R18.2, R18.3).
 *
 * ── What "effective timezone" means ──────────────────────────────────────────
 * Requirement 18.2 says timestamps are shown in the *local time of the viewer's
 * browser*, so the browser's IANA zone is the primary source. The resolved
 * {@link CurrentUser}'s `timezone` is carried as context (it may be `null`,
 * meaning "fall back to the browser" — see the model docs) and only used if the
 * browser cannot report a zone. `UTC` is the final fallback so a rendered date
 * is never ambiguous.
 *
 * Resolution order:
 *   1. the browser's IANA timezone (`Intl.DateTimeFormat().resolvedOptions()`);
 *   2. `CurrentUser.timezone`, when valid;
 *   3. {@link FALLBACK_TIMEZONE} (`UTC`).
 *
 * The value is validated against the platform's own timezone database so the
 * IANA name handed to the stats endpoints as `?tz=` is one the backend (and its
 * Postgres `AT TIME ZONE`) will also accept — the backend applies the exact
 * same validation before it reaches SQL.
 */
@Injectable({ providedIn: 'root' })
export class TimezoneService {
  private readonly currentUser = inject(CurrentUserService);

  /**
   * The IANA timezone dates should be rendered in and month buckets requested
   * for. Reactive: it re-derives if the current user (and therefore their
   * `timezone` context) changes.
   */
  readonly timezone = computed(() => resolveEffectiveTimezone(this.currentUser.user()?.timezone ?? null));

  /**
   * Snapshot accessor for non-reactive callers (e.g. building a `?tz=` query
   * string just before an HTTP call).
   */
  resolve(): string {
    return this.timezone();
  }

  /** The raw IANA timezone reported by the browser, if any. */
  browserTimezone(): string | null {
    return browserTimezone();
  }
}

/**
 * True iff `tz` is a timezone the platform's timezone database recognises. Uses
 * `Intl.DateTimeFormat`, which throws `RangeError` for an unknown/malformed
 * name, mirroring the backend's `isValidTimezone` so a value that passes here
 * is also accepted server-side.
 */
export function isValidTimezone(tz: string | null | undefined): tz is string {
  if (typeof tz !== 'string' || tz.trim() === '') {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

/** The browser's IANA timezone, or `null` when it cannot be determined. */
export function browserTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimezone(tz) ? tz : null;
  } catch {
    return null;
  }
}

/**
 * Pure resolver behind {@link TimezoneService.timezone}: browser zone first,
 * then the supplied `userTimezone` context, then {@link FALLBACK_TIMEZONE}.
 * Exported so it can be unit-tested without the Angular DI graph.
 */
export function resolveEffectiveTimezone(userTimezone: string | null | undefined): string {
  const browser = browserTimezone();
  if (browser) {
    return browser;
  }
  if (isValidTimezone(userTimezone)) {
    return userTimezone.trim();
  }
  return FALLBACK_TIMEZONE;
}
