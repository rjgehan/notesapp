// A chart of a sheet's range (DESIGN §6.21.9), drawn as plain SVG from the cached values, in the
// grid view's chart pane and in embeds. Bars and columns are at most 24 px thick with a rounded data
// end, lines are 2 px with ringed markers, a pie is cut by the surface colour. Series take the
// eight validated categorical colours in a fixed order (styles/sheetChart.css, both themes); text
// stays in text colours; every mark has a tooltip with its value as the sheet shows it.
import '../../styles/sheetChart.css';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { chartData, niceTicks, pieSlices, tickLabel, type ChartData } from '../../sheets/charts';
import type { ChartProps, Sheet } from '../../sheets/format';

interface Props {
  sheet: Sheet;
  chart: ChartProps;
  /** Height of the plot in px. */
  height?: number;
  /** Buttons shown beside the title (edit, delete). */
  actions?: ReactNode;
}

const color = (i: number) => `var(--chart-${(i % 8) + 1})`;
const BAR_MAX = 24;
const GAP = 2;
const LABEL_CHAR = 7;

/** A bar from `y0` (the baseline) to `y1`, its data end rounded. */
function barPath(x: number, w: number, y0: number, y1: number): string {
  const up = y1 <= y0;
  const h = Math.abs(y1 - y0);
  const r = Math.min(4, w / 2, h);
  if (h === 0) return '';
  if (up) {
    return `M${x},${y0}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${y0}Z`;
  }
  return `M${x},${y0}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${y0}Z`;
}

function truncate(text: string, px: number): string {
  const max = Math.max(1, Math.floor(px / LABEL_CHAR));
  return text.length <= max ? text : text.slice(0, Math.max(1, max - 1)) + '…';
}

interface Axes {
  ticks: number[];
  labels: string[];
  m: { top: number; right: number; bottom: number; left: number };
  plotW: number;
  plotH: number;
}

/** The value axis (round ticks, 0 included) and the plot area left beside and below it. */
function axes(data: ChartData, width: number, height: number): Axes {
  const values = data.series.flatMap((s) => s.values).filter((v): v is number => v !== null);
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const labels = ticks.map((t) => tickLabel(t, data.percent));
  const left = Math.max(...labels.map((l) => l.length)) * LABEL_CHAR + 10;
  const m = { top: 8, right: 8, bottom: 22, left };
  return { ticks, labels, m, plotW: Math.max(10, width - m.left - m.right), plotH: Math.max(10, height - m.top - m.bottom) };
}

function CartesianChart({ data, type, width, height }: { data: ChartData; type: 'bar' | 'line'; width: number; height: number }) {
  const { ticks, labels, m, plotW, plotH } = axes(data, width, height);
  const t0 = ticks[0];
  const t1 = ticks[ticks.length - 1];
  const y = (v: number) => m.top + plotH * (1 - (v - t0) / (t1 - t0));
  const n = data.categories.length;
  const band = plotW / n;
  const k = data.series.length;
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(plotW / 64))));
  const base = y(Math.max(t0, Math.min(0, t1)));
  const center = (i: number) => m.left + band * (i + 0.5);
  const marks: ReactNode[] = [];
  if (type === 'bar') {
    const barW = Math.max(1, Math.min(BAR_MAX, (band * 0.8 - GAP * (k - 1)) / k));
    const groupW = barW * k + GAP * (k - 1);
    data.series.forEach((s, j) =>
      s.values.forEach((v, i) => {
        if (v === null) return;
        const x = m.left + band * i + (band - groupW) / 2 + j * (barW + GAP);
        const d = barPath(x, barW, base, y(v));
        if (d === '') return;
        marks.push(
          <path key={`${j}-${i}`} d={d} className="sheet-chart-mark" style={{ fill: color(j) }}>
            <title>{`${data.categories[i]}${s.name ? ` · ${s.name}` : ''}: ${s.shown[i]}`}</title>
          </path>,
        );
      }),
    );
  } else {
    data.series.forEach((s, j) => {
      let d = '';
      let pen = false;
      s.values.forEach((v, i) => {
        if (v === null) {
          pen = false;
          return;
        }
        d += `${pen ? 'L' : 'M'}${center(i)},${y(v)}`;
        pen = true;
      });
      marks.push(<path key={`line-${j}`} d={d} className="sheet-chart-line" style={{ stroke: color(j) }} />);
      if (n <= 60) {
        s.values.forEach((v, i) => {
          if (v === null) return;
          marks.push(
            <circle key={`${j}-${i}`} cx={center(i)} cy={y(v)} r={4} className="sheet-chart-dot" style={{ fill: color(j) }}>
              <title>{`${data.categories[i]}${s.name ? ` · ${s.name}` : ''}: ${s.shown[i]}`}</title>
            </circle>,
          );
        });
      }
    });
  }
  return (
    <svg width={width} height={height} className="sheet-chart-svg" role="presentation">
      {ticks.map((t, i) => (
        <g key={t}>
          <line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} className={t === 0 ? 'sheet-chart-baseline' : 'sheet-chart-grid'} />
          <text x={m.left - 6} y={y(t)} className="sheet-chart-tick" textAnchor="end" dominantBaseline="middle">
            {labels[i]}
          </text>
        </g>
      ))}
      {marks}
      {data.categories.map((c, i) =>
        i % every === 0 ? (
          <text key={`x-${i}`} x={center(i)} y={height - 6} className="sheet-chart-tick" textAnchor="middle">
            {truncate(c, band * every - 4)}
          </text>
        ) : null,
      )}
    </svg>
  );
}

function PieChart({ data, width, height }: { data: ChartData; width: number; height: number }) {
  const slices = pieSlices(data);
  if (slices.length === 0) return <p className="sheet-chart-empty">The pie has no positive values to show.</p>;
  const r = Math.max(10, Math.min(width, height) / 2 - 4);
  const cx = width / 2;
  const cy = height / 2;
  // Each slice's start and end angle, clockwise from twelve o'clock.
  const ends = slices.map((_, i) => -Math.PI / 2 + slices.slice(0, i + 1).reduce((sum, x) => sum + x.share, 0) * Math.PI * 2);
  return (
    <svg width={width} height={height} className="sheet-chart-svg" role="presentation">
      {slices.map((s, i) => {
        const start = i === 0 ? -Math.PI / 2 : ends[i - 1];
        const angle = ends[i];
        const tip = `${s.label}: ${s.shown} (${Math.round(s.share * 1000) / 10}%)`;
        if (slices.length === 1) {
          return (
            <circle key={i} cx={cx} cy={cy} r={r} className="sheet-chart-slice" style={{ fill: color(i) }}>
              <title>{tip}</title>
            </circle>
          );
        }
        const [x1, y1] = [cx + r * Math.cos(start), cy + r * Math.sin(start)];
        const [x2, y2] = [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
        const large = angle - start > Math.PI ? 1 : 0;
        return (
          <path key={i} d={`M${cx},${cy}L${x1},${y1}A${r},${r} 0 ${large} 1 ${x2},${y2}Z`} className="sheet-chart-slice" style={{ fill: color(i) }}>
            <title>{tip}</title>
          </path>
        );
      })}
    </svg>
  );
}

function Legend({ items }: { items: string[] }) {
  return (
    <ul className="sheet-chart-legend">
      {items.map((label, i) => (
        <li key={i}>
          <span className="sheet-chart-swatch" style={{ background: color(i) }} aria-hidden />
          {label}
        </li>
      ))}
    </ul>
  );
}

export function SheetChart({ sheet, chart, height = 200, actions }: Props) {
  const box = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(360);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const style = getComputedStyle(el);
      const inner = el.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
      if (inner > 0) setWidth(Math.floor(inner));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const result = chartData(sheet, chart);
  const type = chart.type ?? 'bar';
  const title = chart.title?.trim() || (result.ok && result.data.series.length === 1 && result.data.series[0].name) || 'Chart';
  let legend: string[] = [];
  if (result.ok && type === 'pie') legend = pieSlices(result.data).map((s) => `${s.label} ${Math.round(s.share * 1000) / 10}%`);
  else if (result.ok && result.data.series.length > 1) legend = result.data.series.map((s) => s.name);
  const hidden = result.ok ? result.data.hiddenSeries + result.data.hiddenCategories : 0;
  return (
    <figure ref={box} className="sheet-chart" aria-label={`${type === 'bar' ? 'Bar' : type === 'line' ? 'Line' : 'Pie'} chart: ${title}`}>
      <figcaption className="sheet-chart-head">
        <span className="sheet-chart-title">{title}</span>
        {actions}
      </figcaption>
      {!chart.type && chart.extra?.type !== undefined ? (
        <p className="sheet-chart-empty">This kind of chart needs a newer NotesApp.</p>
      ) : !result.ok ? (
        <p className="sheet-chart-empty">{result.message}</p>
      ) : (
        <>
          {legend.length > 0 && <Legend items={legend} />}
          <div className="sheet-chart-plot" style={{ height }}>
            {type === 'pie' ? <PieChart data={result.data} width={width} height={height} /> : <CartesianChart data={result.data} type={type} width={width} height={height} />}
          </div>
          {hidden > 0 && (
            <p className="sheet-chart-note">
              {result.data.hiddenSeries > 0 && `${result.data.hiddenSeries} more series not shown. `}
              {result.data.hiddenCategories > 0 && `${result.data.hiddenCategories} more rows not shown.`}
            </p>
          )}
        </>
      )}
    </figure>
  );
}
