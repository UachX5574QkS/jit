import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { LayoutShell } from './layout-shell';

describe('LayoutShell', () => {
  beforeEach(async () => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    await TestBed.configureTestingModule({
      imports: [LayoutShell],
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
  });

  it('creates', () => {
    const fixture = TestBed.createComponent(LayoutShell);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('composes sidebar, header, footer and a router outlet', async () => {
    const fixture = TestBed.createComponent(LayoutShell);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('app-sidebar')).toBeTruthy();
    expect(el.querySelector('app-header')).toBeTruthy();
    expect(el.querySelector('app-footer')).toBeTruthy();
    expect(el.querySelector('router-outlet')).toBeTruthy();
  });

  it('toggles the mobile sidebar open state', async () => {
    const fixture = TestBed.createComponent(LayoutShell);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('.shell.sidebar-open')).toBeFalsy();
    const toggle = el.querySelector<HTMLButtonElement>('.sidebar-toggle');
    toggle?.click();
    await fixture.whenStable();
    expect(el.querySelector('.shell.sidebar-open')).toBeTruthy();
  });
});
