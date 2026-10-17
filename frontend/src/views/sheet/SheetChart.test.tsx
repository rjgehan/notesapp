import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { emptySheet, type ChartProps, type Sheet, type SheetCell } from '../../sheets/format';
import { SheetChart } from './SheetChart';

const SHEET: Sheet = {
  ...emptySheet('s1', 'Budget'),
  cells: {
    A1: { v: 'Month' },
    B1: { v: 'Rent' },
    C1: { v: 'Food' },
    A2: { v: 'Jan' },
    B2: { v: 1450, fmt: '$#,##0' },
    C2: { v: 300 },
    A3: { v: 'Feb' },
    B3: { v: 1500, fmt: '$#,##0' },
    C3: { v: -50 },
  } as Record<string, SheetCell>,
};

const draw = (chart: ChartProps) => render(<SheetChart sheet={SHEET} chart={chart} />);

describe('SheetChart', () => {
  it('draws grouped bars from the baseline, with a legend and a tooltip per bar', () => {
    const { container } = draw({ type: 'bar', range: 'A1:C3', title: 'Costs', headers: true, labels: true });
    expect(screen.getByRole('figure')).toHaveAttribute('aria-label', 'Bar chart: Costs');
    const bars = container.querySelectorAll('path.sheet-chart-mark');
    expect(bars).toHaveLength(4);
    expect([...bars].map((b) => b.querySelector('title')?.textContent)).toEqual(['Jan · Rent: $1,450', 'Feb · Rent: $1,500', 'Jan · Food: 300', 'Feb · Food: -50']);
    expect([...container.querySelectorAll('.sheet-chart-legend li')].map((li) => li.textContent)).toEqual(['Rent', 'Food']);
    // The series colours come from the palette in order.
    expect((bars[0] as SVGPathElement).style.fill).toBe('var(--chart-1)');
    expect((bars[2] as SVGPathElement).style.fill).toBe('var(--chart-2)');
    // Ticks include zero and the negative value.
    expect([...container.querySelectorAll('.sheet-chart-tick')].map((t) => t.textContent)).toContain('0');
  });

  it('draws one line per series with ringed markers, and no legend for a single series', () => {
    const { container } = draw({ type: 'line', range: 'A1:B3', headers: true, labels: true });
    expect(container.querySelectorAll('path.sheet-chart-line')).toHaveLength(1);
    expect(container.querySelectorAll('circle.sheet-chart-dot')).toHaveLength(2);
    expect(container.querySelector('.sheet-chart-legend')).toBeNull();
    // A single series names the chart.
    expect(screen.getByRole('figure')).toHaveAttribute('aria-label', 'Line chart: Rent');
  });

  it('draws a pie of the first series with its shares in the legend', () => {
    const { container } = draw({ type: 'pie', range: 'A2:B3', labels: true });
    expect(container.querySelectorAll('.sheet-chart-slice')).toHaveLength(2);
    expect([...container.querySelectorAll('.sheet-chart-legend li')].map((li) => li.textContent)).toEqual(['Jan 49.2%', 'Feb 50.8%']);
  });

  it('explains a chart it cannot draw', () => {
    draw({ type: 'bar', range: 'A1:A3' });
    expect(screen.getByText('A1:A3 holds no numbers to chart.')).toBeInTheDocument();
    draw({ range: 'A1:B3', extra: { type: 'radar' } });
    expect(screen.getByText('This kind of chart needs a newer NotesApp.')).toBeInTheDocument();
    draw({ type: 'pie', range: 'C3:C3' });
    expect(screen.getByText('The pie has no positive values to show.')).toBeInTheDocument();
  });
});
