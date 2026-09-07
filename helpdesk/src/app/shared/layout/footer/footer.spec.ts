import { TestBed } from '@angular/core/testing';
import { Footer } from './footer';

describe('Footer', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Footer],
    }).compileComponents();
  });

  it('creates', () => {
    const fixture = TestBed.createComponent(Footer);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('renders the brand name and a privacy link', async () => {
    const fixture = TestBed.createComponent(Footer);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.brand-name')?.textContent).toContain('Helpdesk');
    expect(el.querySelector('.privacy-link')).toBeTruthy();
  });

  it('shows the current year in the copyright line', async () => {
    const fixture = TestBed.createComponent(Footer);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain(String(new Date().getFullYear()));
  });
});
