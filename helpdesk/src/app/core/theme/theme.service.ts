import { DOCUMENT } from '@angular/common';
import { Injectable, computed, inject, signal } from '@angular/core';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'helpdesk.theme';

/**
 * Drives light/dark mode for the ui-foundations shell.
 *
 * The chosen theme is applied by toggling the `dark` class on the root
 * `<html>` element (all dark colour tokens hang off `html.dark`) and is
 * persisted to `localStorage` so it survives reloads.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);

  private readonly _theme = signal<Theme>(this.readInitialTheme());

  /** Current theme as a readonly signal. */
  readonly theme = this._theme.asReadonly();

  /** True when dark mode is active. */
  readonly isDark = computed(() => this._theme() === 'dark');

  constructor() {
    this.applyTheme(this._theme());
  }

  /** Explicitly set the active theme. */
  setTheme(theme: Theme): void {
    this._theme.set(theme);
    this.persist(theme);
    this.applyTheme(theme);
  }

  /** Flip between light and dark. */
  toggle(): void {
    this.setTheme(this._theme() === 'dark' ? 'light' : 'dark');
  }

  private applyTheme(theme: Theme): void {
    const root = this.document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
  }

  private persist(theme: Theme): void {
    try {
      this.document.defaultView?.localStorage?.setItem(STORAGE_KEY, theme);
    } catch {
      /* localStorage may be unavailable (private mode / SSR); ignore. */
    }
  }

  private readInitialTheme(): Theme {
    try {
      const stored = this.document.defaultView?.localStorage?.getItem(STORAGE_KEY);
      if (stored === 'dark' || stored === 'light') {
        return stored;
      }
      const prefersDark =
        this.document.defaultView?.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false;
      return prefersDark ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  }
}
