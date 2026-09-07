import { TestBed } from '@angular/core/testing';
import { StackedBarChartComponent } from './stacked-bar-chart';
import type { StackedBar } from './chart-data';

const BARS: StackedBar[] = [
  { label: '2026-01', segments: [{ label: 'New', value: 2 }, { label: 'Active', value: 1 }] },
  { label: '2026-02', segments: [{ label: 'New', value: 1 }, { label: 'Complete', value: 3 }] },
];

function setup(bars: readonly StackedBar[], heading = '') {
  const fixture = TestBed.createComponent(StackedBarChartComponent);
  fixture.componentRef.setInput('bars', bars);
  fixture.componentRef.setInput('heading', heading);
  fixture.detectChanges();
  return fixture;
}

describe('StackedBarChartComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [StackedBarChartComponent] }).compileComponents();
  });

  it('creates', () => {
    const fixture = setup(BARS);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('renders one .bar-row per bar with label, segments, and total value', () => {
    const el = setup(BARS).nativeElement as HTMLElement;
    const rows = el.querySelectorAll('.bar-row');
    expect(rows.length).toBe(2);
    const firstRow = rows[0];
    expect(firstRow.querySelector('.bar-label')?.textContent).toContain('2026-01');
    // Two segments in the first bar.
    expect(firstRow.querySelectorAll('.bar-segment').length).toBe(2);
    // Total of the first bar = 3.
    expect(firstRow.querySelector('.bar-value')?.textContent).toContain('3');
  });

  it('builds a legend of distinct series labels', () => {
    const el = setup(BARS).nativeElement as HTMLElement;
    const labels = [...el.querySelectorAll('.legend-label')].map((n) => n.textContent?.trim());
    expect(labels).toEqual(['New', 'Active', 'Complete']);
  });

  it('renders the heading when supplied', () => {
    const el = setup(BARS, 'Requests by status').nativeElement as HTMLElement;
    expect(el.querySelector('.chart-heading')?.textContent).toContain('Requests by status');
  });

  it('shows an empty state when there is no data', () => {
    const el = setup([]).nativeElement as HTMLElement;
    expect(el.querySelector('.chart-empty')).toBeTruthy();
    expect(el.querySelector('.bar-row')).toBeNull();
  });
});
