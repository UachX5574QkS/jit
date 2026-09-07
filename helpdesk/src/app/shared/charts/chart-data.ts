/**
 * Shared datasets and helpers for the dashboard chart wrappers (design:
 * "shared/ … bar/pie charts"; statistics R10, R11, R12; UI spec "Bar Charts").
 *
 * The chart wrappers are presentation-only: they take an already-aggregated
 * dataset (the shape the stats endpoints return — status-by-month buckets and
 * per-type slices, see `backend/src/routes/stats-*.store.ts`) and render it in
 * the ui-foundations style. They do NOT fetch or aggregate; the statistics
 * feature (tasks 8.x / the stats screens) maps its endpoint payload into these
 * view models and hands them in.
 */

/** The default purple / purple-light series palette from the UI spec. */
export const CHART_COLORS = ['#5A287D', '#7A4A9E', '#9B6BBF', '#B98FD6', '#D7BCEA'] as const;

/** Colours for pie slices — the purple family, extended with the accent tokens. */
export const PIE_COLORS = [
  '#5A287D',
  '#7A4A9E',
  '#9B6BBF',
  '#23A656',
  '#F2A900',
  '#D5281B',
  '#B98FD6',
  '#5B5B6E',
] as const;

/** One value within a stacked bar (e.g. a status count within a month). */
export interface StackSegment {
  /** The series label (e.g. a status name). */
  readonly label: string;
  /** The magnitude of this segment. */
  readonly value: number;
  /** Optional explicit colour; otherwise a palette colour is assigned by index. */
  readonly color?: string;
}

/** One bar (row) of a stacked bar chart: a category and its stacked segments. */
export interface StackedBar {
  /** The row label shown on the left (e.g. a `YYYY-MM` month, R10.1). */
  readonly label: string;
  /** The segments stacked within this bar, in order. */
  readonly segments: readonly StackSegment[];
}

/** One slice of a pie chart (e.g. a task type's request count, R10.2/R10.3). */
export interface PieSlice {
  readonly label: string;
  readonly value: number;
  readonly color?: string;
}

/** A stacked-bar segment with its resolved geometry for rendering. */
export interface RenderedSegment extends StackSegment {
  /** Segment width as a percentage of the CHART's max bar total (0–100). */
  readonly widthPct: number;
  readonly color: string;
}

/** A stacked bar with its segments resolved to widths + colours. */
export interface RenderedBar {
  readonly label: string;
  readonly total: number;
  readonly segments: readonly RenderedSegment[];
}

/** A pie slice resolved to its sweep angle, percentage, and colour. */
export interface RenderedSlice extends PieSlice {
  /** Share of the total, 0–100. */
  readonly percent: number;
  /** Cumulative start angle in degrees (0 at 12 o'clock, clockwise). */
  readonly startAngle: number;
  /** Cumulative end angle in degrees. */
  readonly endAngle: number;
  readonly color: string;
}

/** The sum of a bar's segment values. */
export function barTotal(bar: StackedBar): number {
  return bar.segments.reduce((acc, s) => acc + Math.max(0, s.value), 0);
}

/**
 * Resolve stacked bars to render geometry. Segment widths are expressed as a
 * percentage of the LARGEST bar total across the chart, so bars are comparable
 * (the longest bar fills the track; shorter bars are proportionally shorter),
 * matching the `.bar-row` track semantics of the UI spec. Colours fall back to
 * the shared palette by segment index when not supplied.
 */
export function renderStackedBars(bars: readonly StackedBar[]): RenderedBar[] {
  const maxTotal = bars.reduce((max, bar) => Math.max(max, barTotal(bar)), 0);
  return bars.map((bar) => {
    const total = barTotal(bar);
    const segments = bar.segments.map((seg, i) => ({
      ...seg,
      color: seg.color ?? CHART_COLORS[i % CHART_COLORS.length],
      widthPct: maxTotal > 0 ? (Math.max(0, seg.value) / maxTotal) * 100 : 0,
    }));
    return { label: bar.label, total, segments };
  });
}

/**
 * Resolve pie slices to render geometry: each slice's percentage of the total
 * and its cumulative start/end angles (degrees, clockwise from 12 o'clock).
 * Slices with a non-positive value are dropped. When every value is zero the
 * result is empty (the wrapper shows an empty state). Colours fall back to the
 * shared pie palette by index.
 */
export function renderPieSlices(slices: readonly PieSlice[]): RenderedSlice[] {
  const positive = slices.filter((s) => s.value > 0);
  const total = positive.reduce((acc, s) => acc + s.value, 0);
  if (total <= 0) {
    return [];
  }
  let cursor = 0;
  return positive.map((slice, i) => {
    const percent = (slice.value / total) * 100;
    const sweep = (slice.value / total) * 360;
    const startAngle = cursor;
    const endAngle = cursor + sweep;
    cursor = endAngle;
    return {
      ...slice,
      percent,
      startAngle,
      endAngle,
      color: slice.color ?? PIE_COLORS[i % PIE_COLORS.length],
    };
  });
}

/**
 * The SVG path `d` for a pie slice (a "pie", not a donut) on a unit circle of
 * the given `radius` centred at (`cx`,`cy`). Angles are in degrees measured
 * clockwise from 12 o'clock. A single slice covering the whole circle (≥ ~360°)
 * is rendered as a full circle path to avoid the degenerate zero-length arc.
 */
export function sliceArcPath(
  slice: Pick<RenderedSlice, 'startAngle' | 'endAngle'>,
  cx: number,
  cy: number,
  radius: number,
): string {
  const sweep = slice.endAngle - slice.startAngle;
  if (sweep >= 359.999) {
    // Full circle: two half-arcs so the path is a closed circle.
    const top = polar(cx, cy, radius, 0);
    const bottom = polar(cx, cy, radius, 180);
    return [
      `M ${top.x} ${top.y}`,
      `A ${radius} ${radius} 0 1 1 ${bottom.x} ${bottom.y}`,
      `A ${radius} ${radius} 0 1 1 ${top.x} ${top.y}`,
      'Z',
    ].join(' ');
  }
  const start = polar(cx, cy, radius, slice.startAngle);
  const end = polar(cx, cy, radius, slice.endAngle);
  const largeArc = sweep > 180 ? 1 : 0;
  return [
    `M ${cx} ${cy}`,
    `L ${start.x} ${start.y}`,
    `A ${radius} ${radius} 0 ${largeArc} 1 ${end.x} ${end.y}`,
    'Z',
  ].join(' ');
}

/** Convert a polar angle (degrees, clockwise from 12 o'clock) to an (x,y) point. */
function polar(cx: number, cy: number, radius: number, angleDeg: number): { x: number; y: number } {
  // 12 o'clock is -90° in standard math orientation; clockwise is +angle.
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: round(cx + radius * Math.cos(rad)),
    y: round(cy + radius * Math.sin(rad)),
  };
}

/** Round to 3 dp so generated path strings are compact and stable. */
function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
