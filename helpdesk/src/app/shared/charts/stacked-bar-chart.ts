import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import {
  CHART_COLORS,
  renderStackedBars,
  type StackedBar,
} from './chart-data';

/** One entry in the chart legend: a series label and its colour. */
interface LegendEntry {
  readonly label: string;
  readonly color: string;
}

/**
 * A stacked bar chart wrapper in the ui-foundations style (design: "shared/ …
 * bar/pie charts"; UI spec "Bar Charts": `.bar-row` layout — label → track →
 * value). It renders the "number of requests by status, broken down by month"
 * dataset used across the statistics dashboards (R10.1, R11, R12.2).
 *
 * ── Presentation-only ────────────────────────────────────────────────────────
 * It takes an already-aggregated {@link StackedBar} list (one bar per month,
 * one segment per status — exactly the `statusByMonth` buckets the stats stores
 * return) and lays each bar out as a row: a fixed-width label, a flexible track
 * holding the stacked coloured segments, and the bar total on the right. It does
 * NOT fetch or aggregate — the statistics feature maps its endpoint payload into
 * bars and hands them in.
 *
 * ── Layout & style ───────────────────────────────────────────────────────────
 * Segment widths are proportional to the largest bar total so bars are
 * comparable; the track is the 8px muted rounded bar from the spec and segment
 * fills use the purple series palette (overridable per segment). A legend maps
 * each series label to its colour. Widths animate via a CSS transition that is
 * disabled under `prefers-reduced-motion`.
 */
@Component({
  selector: 'app-stacked-bar-chart',
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './stacked-bar-chart.html',
  styleUrl: './stacked-bar-chart.scss',
})
export class StackedBarChartComponent {
  /** Optional heading shown above the chart. */
  readonly heading = input<string>('');

  /** The aggregated bars to render (one per category, e.g. a month). */
  readonly bars = input.required<readonly StackedBar[]>();

  /** The resolved bars with per-segment widths and colours. */
  protected readonly renderedBars = computed(() => renderStackedBars(this.bars()));

  /** Whether there is anything to draw (at least one non-empty bar). */
  protected readonly hasData = computed(() =>
    this.renderedBars().some((bar) => bar.total > 0),
  );

  /**
   * The legend: one entry per DISTINCT series label across all bars, in first-
   * seen order, each with the colour it renders in. Built from the resolved
   * segments so it matches exactly what is drawn.
   */
  protected readonly legend = computed<LegendEntry[]>(() => {
    const seen = new Map<string, string>();
    for (const bar of this.renderedBars()) {
      for (const seg of bar.segments) {
        if (!seen.has(seg.label)) {
          seen.set(seg.label, seg.color);
        }
      }
    }
    if (seen.size === 0) {
      return [];
    }
    return [...seen.entries()].map(([label, color]) => ({ label, color }));
  });

  protected readonly fallbackColor = CHART_COLORS[0];
}
