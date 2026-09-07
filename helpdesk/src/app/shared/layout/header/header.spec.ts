import { TestBed } from '@angular/core/testing';
import { ThemeService } from '../../../core/theme/theme.service';
import { Header } from './header';

describe('Header', () => {
  beforeEach(async () => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    await TestBed.configureTestingModule({
      imports: [Header],
    }).compileComponents();
  });

  it('creates', () => {
    const fixture = TestBed.createComponent(Header);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('renders a search input and action buttons', async () => {
    const fixture = TestBed.createComponent(Header);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('input[type="search"]')).toBeTruthy();
    expect(el.querySelectorAll('.icon-btn').length).toBeGreaterThanOrEqual(4);
  });

  it('toggles dark mode when the toggle button is clicked', async () => {
    const theme = TestBed.inject(ThemeService);
    theme.setTheme('light');
    const fixture = TestBed.createComponent(Header);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    const toggle = el.querySelector<HTMLButtonElement>('.icon-btn');
    toggle?.click();
    await fixture.whenStable();

    expect(theme.isDark()).toBe(true);
  });
});
