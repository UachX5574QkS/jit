import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';

/** The available text-size choices. */
export type TextSize = 'small' | 'medium' | 'large' | 'x-large';

/** Ordered options with user-facing labels for the header drop-down. */
export const TEXT_SIZE_OPTIONS: ReadonlyArray<{ value: TextSize; label: string }> = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' },
  { value: 'x-large', label: 'Extra Large' },
];

const STORAGE_KEY = 'helpdesk.textSize';
const DEFAULT_SIZE: TextSize = 'medium';
const VALID: ReadonlySet<string> = new Set(TEXT_SIZE_OPTIONS.map((o) => o.value));

/**
 * Drives the app-wide TEXT SIZE for accessibility (users may trade a smaller
 * font for less table wrapping, or a larger font — accepting more wrapping —
 * for readability).
 *
 * The choice is applied by setting `data-text-size` on the root `<html>`
 * element; the global stylesheet maps each value to a content scale (see
 * styles.scss). Persisted to `localStorage` so it survives reloads.
 */
@Injectable({ providedIn: 'root' })
export class TextSizeService {
  private readonly document = inject(DOCUMENT);

  private readonly _size = signal<TextSize>(this.readInitial());

  /** The current text size as a readonly signal. */
  readonly size = this._size.asReadonly();

  /** The available options (for binding in the header drop-down). */
  readonly options = computed(() => TEXT_SIZE_OPTIONS);

  constructor() {
    this.apply(this._size());
  }

  /** Set the active text size (persisted + applied to the document root). */
  setSize(size: TextSize): void {
    const next = VALID.has(size) ? size : DEFAULT_SIZE;
    this._size.set(next);
    this.persist(next);
    this.apply(next);
  }

  private apply(size: TextSize): void {
    this.document.documentElement.setAttribute('data-text-size', size);
  }

  private persist(size: TextSize): void {
    try {
      this.document.defaultView?.localStorage?.setItem(STORAGE_KEY, size);
    } catch {
      /* localStorage may be unavailable (private mode / SSR); ignore. */
    }
  }

  private readInitial(): TextSize {
    try {
      const stored = this.document.defaultView?.localStorage?.getItem(STORAGE_KEY);
      if (stored && VALID.has(stored)) {
        return stored as TextSize;
      }
    } catch {
      /* ignore */
    }
    return DEFAULT_SIZE;
  }
}
