import { TestBed } from '@angular/core/testing';
import { ThemeService } from './theme.service';

describe('ThemeService', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    TestBed.configureTestingModule({});
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  it('toggles between light and dark', () => {
    const service = TestBed.inject(ThemeService);
    const start = service.isDark();

    service.toggle();
    expect(service.isDark()).toBe(!start);

    service.toggle();
    expect(service.isDark()).toBe(start);
  });

  it('applies the dark class to the document root when dark', () => {
    const service = TestBed.inject(ThemeService);
    service.setTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    service.setTheme('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('persists the chosen theme to localStorage', () => {
    const service = TestBed.inject(ThemeService);
    service.setTheme('dark');
    expect(localStorage.getItem('helpdesk.theme')).toBe('dark');
  });

  it('restores a persisted theme on construction', () => {
    localStorage.setItem('helpdesk.theme', 'dark');
    const service = TestBed.inject(ThemeService);
    expect(service.isDark()).toBe(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
