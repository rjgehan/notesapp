// Charts of a sheet (ROADMAP item 6c, DESIGN §6.21.9): what a bar, line or pie chart shows of its
// range, read from the cached values, so the grid and embeds draw charts without the engine.
// Columns are series and rows are categories, as in Google Sheets: the first row can name the
// series (`headers`) and the first column label the categories (`labels`).
import { columnLetters, toA1 } from './a1';
import { effectiveFormat, shownCell } from './display';
import { cellValue, type ChartProps, type Sheet } from './format';
import { formatKind } from './numfmt';
import { parseRangeText, rangeText, type CellRange } from './refs';

/** At most this many series and categories are drawn; the eight series colours are never reused. */
export const MAX_SERIES = 8;
export const MAX_CATEGORIES = 500;
/** A pie shows this many slices at most; the rest are summed as "Other". */
export const MAX_SLICES = 8;

export interface ChartSeries {
  name: string;
  /** null where the cell holds no number (a gap). */
  values: Array<number | null>;
  /** The values as their cells show them, for tooltips. */
  shown: string[];
}

export interface ChartData {
  categories: string[];
  series: ChartSeries[];
  /** The first value cell's number format shows percentages: axis ticks get a %. */
  percent: boolean;
  /** Series and categories left out by the limits. */
  hiddenSeries: number;
  hiddenCategories: number;
}

export type ChartResult = { ok: true; data: ChartData } | { ok: false; message: string };

/** The chart's range on its own sheet, or null when it is not a range. */
export function chartRange(chart: ChartProps): CellRange | null {
  return chart.range ? (parseRangeText(chart.range)?.range ?? null) : null;
}

const isText = (sheet: Sheet, col: number, row: number) => {
  const v = cellValue(sheet.cells[toA1(col, row)]);
  return typeof v === 'string' && v.trim() !== '';
};

/**
 * Header and label options for a new chart of `range`, as Google Sheets guesses them: the first
 * row names the series when it holds text above the values, and the first column (of two or more)
 * labels the categories when it holds text.
 */
export function guessChartOptions(sheet: Sheet, range: CellRange): Pick<ChartProps, 'headers' | 'labels'> {
  let headers = false;
  if (range.height > 1) {
    for (let col = range.col + (range.width > 1 ? 1 : 0); col < range.col + range.width; col++) if (isText(sheet, col, range.row)) headers = true;
  }
  let labels = false;
  if (range.width > 1) {
    for (let row = range.row + (headers ? 1 : 0); row < range.row + range.height; row++) if (isText(sheet, range.col, row)) labels = true;
  }
  return { headers, labels };
}

/** What a chart shows, or why it shows nothing. */
export function chartData(sheet: Sheet, chart: ChartProps): ChartResult {
  const range = chartRange(chart);
  if (!range) return { ok: false, message: chart.range ? `“${chart.range}” is not a range.` : 'The chart has no range.' };
  const headers = chart.headers === true && range.height > 1;
  const labels = chart.labels === true && range.width > 1;
  const firstRow = range.row + (headers ? 1 : 0);
  const firstCol = range.col + (labels ? 1 : 0);
  const rows = range.row + range.height - firstRow;
  const cols = range.col + range.width - firstCol;
  if (rows <= 0 || cols <= 0) return { ok: false, message: 'The range has no values to chart.' };
  const categoryCount = Math.min(rows, MAX_CATEGORIES);
  const seriesCount = Math.min(cols, MAX_SERIES);
  const categories: string[] = [];
  for (let i = 0; i < categoryCount; i++) {
    const row = firstRow + i;
    categories.push(labels ? shownCell(sheet, range.col, row).text : String(row + 1));
  }
  const series: ChartSeries[] = [];
  let numbers = 0;
  for (let j = 0; j < seriesCount; j++) {
    const col = firstCol + j;
    const name = headers ? shownCell(sheet, col, range.row).text : '';
    const values: Array<number | null> = [];
    const shown: string[] = [];
    for (let i = 0; i < categoryCount; i++) {
      const row = firstRow + i;
      const v = cellValue(sheet.cells[toA1(col, row)]);
      const n = typeof v === 'number' && Number.isFinite(v) ? v : null;
      if (n !== null) numbers++;
      values.push(n);
      shown.push(shownCell(sheet, col, row).text);
    }
    series.push({ name: name || `Column ${columnLetters(col)}`, values, shown });
  }
  if (numbers === 0) return { ok: false, message: `${rangeText(range)} holds no numbers to chart.` };
  const percent = formatKind(effectiveFormat(sheet, firstCol, firstRow)) === 'percent';
  return { ok: true, data: { categories, series, percent, hiddenSeries: cols - seriesCount, hiddenCategories: rows - categoryCount } };
}

export interface PieSlice {
  label: string;
  value: number;
  shown: string;
  /** Share of the whole, 0–1. */
  share: number;
}

/**
 * The slices of a pie: the first series' positive values, the largest first beyond the limit, with
 * the remaining ones summed as "Other". Zero, negative and empty values are left out.
 */
export function pieSlices(data: ChartData): PieSlice[] {
  const s = data.series[0];
  if (!s) return [];
  const items = data.categories
    .map((label, i) => ({ label, value: s.values[i] ?? 0, shown: s.shown[i] ?? '' }))
    .filter((x) => x.value > 0);
  const total = items.reduce((sum, x) => sum + x.value, 0);
  if (total <= 0) return [];
  let kept = items;
  if (items.length > MAX_SLICES) {
    const sorted = [...items].sort((a, b) => b.value - a.value);
    const head = new Set(sorted.slice(0, MAX_SLICES - 1));
    const rest = items.filter((x) => !head.has(x)).reduce((sum, x) => sum + x.value, 0);
    kept = [...items.filter((x) => head.has(x)), { label: 'Other', value: rest, shown: String(Number(rest.toPrecision(15))) }];
  }
  return kept.map((x) => ({ ...x, share: x.value / total }));
}

/** Round axis ticks from `min` to `max` (0 included), about `count` of them. */
export function niceTicks(min: number, max: number, count = 5): number[] {
  let lo = Math.min(0, min);
  let hi = Math.max(0, max);
  if (lo === hi) hi = lo + 1;
  const raw = (hi - lo) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw) ?? 10 * magnitude;
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Number(t.toPrecision(12)));
  return ticks;
}

/** An axis tick: compact from 1,000 up (1K, 2.5M), a percentage for percent values. */
export function tickLabel(value: number, percent: boolean): string {
  if (percent) return `${Number((value * 100).toPrecision(12))}%`;
  const abs = Math.abs(value);
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, unit] of units) if (abs >= size) return `${Number((value / size).toPrecision(3))}${unit}`;
  return String(Number(value.toPrecision(6)));
}
