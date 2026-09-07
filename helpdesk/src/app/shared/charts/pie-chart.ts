import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  renderPieSlices,
  sliceArcPath,
  type PieSlice,
  type RenderedSlice,
} from './chart-data';

/** The SVG viewBox geometry — a square canvas with a centred circle. */
const SIZE = 160;
const CENTER = SIZE / 2;
const RADIUS = SIZE / 2 - 4;

/** A rendered slice paired with its SVG path and legend text. */
interface PieSegment extends RenderedSlice {
  readonly path: string;
  /** e.g. "New — 42%" for the legend/label. */
  readonly legend: string;
}

/**
 * A pie chart wrapper in the ui-foundations style (design: "shared/ … bar/pie
 * charts"; statistics R10.2, R10.3, R11). It renders the "count by task type"
 * and "recorded time by task type" datasets as proportional slices.
 *
 * ── Presentation-only ────────────────────────────────────────────────────────
 * It takes an already-aggregated {@link PieSlice} list (label + value — exactly
 * the per-type slices the stats stores return, e.g. `typeCounts` / `timeByType`)
 * and draws each as a proportional wedge of an SVG circle, with a legend showing
 * each slice's share of the total. It does NOT fetch or aggregate — the
 * statistics feature maps its endpoint payload into slices and hands them in.
 * Two of these sit side by side on the User Statistics page (the type-count pie
 * and, to its right, the time-by-type pie, R10.2–10.3).
 *
 * ── Proportions ──────────────────────────────────────────────────────────────
 * Slices are sized by value as a proportion of the total (R10.3). Non-positive
 * values are dropped; when every value is zero an empty state is shown. Colours
 * come from the shared pie palette (overridable per slice).
 */
@Component({
  selector: 'app-pie-chart',
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './pie-chart.html',
  styleUrl: './pie-chart.scss',
})
export class PieChartComponent {
  /** Optional heading shown above the chart. */
  readonly heading = input<string>('');

  /** The aggregated slices to render. */
  readonly slices = input.required<readonly PieSlice[]>();

  protected readonly size = SIZE;
  protected readonly center = CENTER;
  protected readonly radius = RADIUS;

  /** The resolved slices with angles, percentages, colours, and SVG paths. */
  protected readonly segments = computed<PieSegment[]>(() =>
    renderPieSlices(this.slices()).map((slice) => ({
      ...slice,
      path: sliceArcPath(slice, CENTER, CENTER, RADIUS),
      legend: `${slice.label} — ${formatPercent(slice.percent)}`,
    })),
  );

  /** Whether there is anything to draw. */
  protected readonly hasData = computed(() => this.segments().length > 0);
}

/** Format a 0–100 percentage as a whole-number percent, e.g. `42%`. */
function formatPercent(percent: number): string {
  return `${Math.round(percent)}%`;
}
