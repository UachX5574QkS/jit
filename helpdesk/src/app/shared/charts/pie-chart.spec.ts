import { TestBed } from '@angular/core/testing';
import { PieChartComponent } from './pie-chart';
import type { PieSlice } from './chart-data';

const SLICES: PieSlice[] = [
  { label: 'Bug', value: 3 },
  { label: 'Task', value: 1 },
];

function setup(slices: readonly PieSlice[], heading = '') {
  const fixture = TestBed.createComponent(PieChartComponent);
  fixture.componentRef.setInput('slices', slices);
  fixture.componentRef.setInput('heading', heading);
  fixture.detectChanges();
  return fixture;
}

describe('PieChartComponent', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [PieChartComponent] }).compileComponents();
  });

  it('creates', () => {
    expect(setup(SLICES).componentInstance).toBeTruthy();
  });

  it('renders one SVG path per positive slice', () => {
    const el = setup(SLICES).nativeElement as HTMLElement;
    expect(el.querySelectorAll('path.pie-slice').length).toBe(2);
  });

  it('renders a legend showing each slice proportion (R10.3)', () => {
    const el = setup(SLICES).nativeElement as HTMLElement;
    const legend = [...el.querySelectorAll('.legend-label')].map((n) => n.textContent?.trim());
    expect(legend).toEqual(['Bug — 75%', 'Task — 25%']);
  });

  it('renders the heading when supplied', () => {
    const el = setup(SLICES, 'By type').nativeElement as HTMLElement;
    expect(el.querySelector('.chart-heading')?.textContent).toContain('By type');
  });

  it('shows an empty state when all values are zero', () => {
    const el = setup([{ label: 'A', value: 0 }]).nativeElement as HTMLElement;
    expect(el.querySelector('.chart-empty')).toBeTruthy();
    expect(el.querySelector('path.pie-slice')).toBeNull();
  });
});
