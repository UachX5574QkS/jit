import {
  barTotal,
  renderPieSlices,
  renderStackedBars,
  sliceArcPath,
  type PieSlice,
  type StackedBar,
} from './chart-data';

describe('barTotal', () => {
  it('sums non-negative segment values', () => {
    const bar: StackedBar = {
      label: '2026-01',
      segments: [
        { label: 'New', value: 3 },
        { label: 'Active', value: 2 },
      ],
    };
    expect(barTotal(bar)).toBe(5);
  });
});

describe('renderStackedBars', () => {
  const bars: StackedBar[] = [
    { label: '2026-01', segments: [{ label: 'New', value: 2 }, { label: 'Active', value: 2 }] },
    { label: '2026-02', segments: [{ label: 'New', value: 1 }, { label: 'Active', value: 1 }] },
  ];

  it('scales segment widths against the largest bar total', () => {
    const rendered = renderStackedBars(bars);
    // Largest total is 4 (Jan). Jan segments = 2/4 = 50% each.
    expect(rendered[0].total).toBe(4);
    expect(rendered[0].segments[0].widthPct).toBe(50);
    // Feb segments = 1/4 = 25% each (comparable across bars).
    expect(rendered[1].segments[0].widthPct).toBe(25);
  });

  it('assigns palette colours when none are supplied', () => {
    const rendered = renderStackedBars(bars);
    expect(rendered[0].segments[0].color).toMatch(/^#/);
    expect(rendered[0].segments[1].color).not.toBe(rendered[0].segments[0].color);
  });

  it('handles an all-zero chart without dividing by zero', () => {
    const zero: StackedBar[] = [{ label: 'm', segments: [{ label: 'New', value: 0 }] }];
    const rendered = renderStackedBars(zero);
    expect(rendered[0].segments[0].widthPct).toBe(0);
  });
});

describe('renderPieSlices', () => {
  const slices: PieSlice[] = [
    { label: 'Bug', value: 3 },
    { label: 'Task', value: 1 },
  ];

  it('computes proportional percentages and cumulative angles', () => {
    const rendered = renderPieSlices(slices);
    expect(rendered[0].percent).toBe(75);
    expect(rendered[1].percent).toBe(25);
    expect(rendered[0].startAngle).toBe(0);
    expect(rendered[0].endAngle).toBeCloseTo(270);
    expect(rendered[1].endAngle).toBeCloseTo(360);
  });

  it('drops non-positive slices', () => {
    const rendered = renderPieSlices([
      { label: 'A', value: 5 },
      { label: 'B', value: 0 },
      { label: 'C', value: -1 },
    ]);
    expect(rendered.map((s) => s.label)).toEqual(['A']);
    expect(rendered[0].percent).toBe(100);
  });

  it('returns empty when the total is zero (empty-state)', () => {
    expect(renderPieSlices([{ label: 'A', value: 0 }])).toEqual([]);
  });
});

describe('sliceArcPath', () => {
  it('builds a wedge path for a partial slice', () => {
    const path = sliceArcPath({ startAngle: 0, endAngle: 90 }, 80, 80, 76);
    expect(path.startsWith('M 80 80')).toBe(true);
    expect(path).toContain('A 76 76');
    expect(path.endsWith('Z')).toBe(true);
  });

  it('renders a full circle for a single 360° slice', () => {
    const path = sliceArcPath({ startAngle: 0, endAngle: 360 }, 80, 80, 76);
    // Full-circle path uses two arcs and does not draw to the centre.
    expect(path).toContain('A 76 76');
    expect(path).not.toContain('L 80 80');
  });
});
