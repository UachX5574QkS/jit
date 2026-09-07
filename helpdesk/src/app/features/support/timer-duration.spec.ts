import { describe, expect, it } from 'vitest';
import {
  MIN_SLICE_MINUTES,
  elapsedMinutesSince,
  formatDuration,
  toDurationParts,
} from './timer-duration';

/**
 * Unit tests for the timer duration helpers (task 12.3; R8.4, R8.5). They pin
 * the elapsed-minute calculation and the days/hours/minutes presentation the
 * "Back to Queue" pop-up relies on.
 */
describe('timer-duration helpers (R8.4)', () => {
  describe('elapsedMinutesSince', () => {
    it('rounds the elapsed minutes between started and now', () => {
      const now = Date.parse('2026-02-05T11:30:00.000Z');
      expect(elapsedMinutesSince('2026-02-05T10:00:00.000Z', now)).toBe(90);
    });

    it('floors at the 1-minute minimum for a just-started timer (R8.4)', () => {
      const now = Date.parse('2026-02-05T10:00:10.000Z');
      expect(elapsedMinutesSince('2026-02-05T10:00:00.000Z', now)).toBe(MIN_SLICE_MINUTES);
    });

    it('returns the minimum for an unparseable start', () => {
      expect(elapsedMinutesSince('not-a-date')).toBe(MIN_SLICE_MINUTES);
    });
  });

  describe('toDurationParts', () => {
    it('splits minutes into days / hours / minutes', () => {
      // 1 day 2 hours 5 minutes = 1565 minutes.
      expect(toDurationParts(1565)).toEqual({ days: 1, hours: 2, minutes: 5 });
    });

    it('clamps negatives to zero', () => {
      expect(toDurationParts(-10)).toEqual({ days: 0, hours: 0, minutes: 0 });
    });
  });

  describe('formatDuration', () => {
    it('shows minutes only for a sub-hour duration', () => {
      expect(formatDuration(3)).toBe('3m');
    });

    it('shows hours and minutes for a sub-day duration', () => {
      expect(formatDuration(125)).toBe('2h 5m');
    });

    it('shows days, hours and minutes for a multi-day duration', () => {
      expect(formatDuration(1565)).toBe('1d 2h 5m');
    });

    it('keeps a zero hours segment when days are present', () => {
      // 1 day 0 hours 30 minutes.
      expect(formatDuration(24 * 60 + 30)).toBe('1d 0h 30m');
    });
  });
});
