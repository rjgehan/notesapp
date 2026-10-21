import { describe, expect, it } from 'vitest';
import { chartData, guessChartOptions, MAX_SERIES, niceTicks, pieSlices, tickLabel, type ChartData } from './charts';
import { emptySheet, type Sheet, type SheetCell } from './format';

function sheet(cells: Record<string, SheetCell>): Sheet {
  return { ...emptySheet('s1', 'Budget'), cells };
}

const BUDGET = sheet({
  A1: { v: 'Month' },
  B1: { v: 'Rent' },
  C1: { v: 'Food' },
  A2: { v: 'Jan' },
  B2: { v: 1450, fmt: '$#,##0' },
  C2: { v: 300 },
  A3: { v: 'Feb' },
  B3: { f: '=B2', c: 1450 },
  C3: { v: 'n/a' },
  A4: { v: 'Mar' },
  B4: { v: 1500 },
  C4: { f: '=1/0', c: { e: '#DIV/0!' } },
});

const ok = (data: ReturnType<typeof chartData>): ChartData => {
  if (!data.ok) throw new Error(data.message);
  return data.data;
};

describe('chartData', () => {
  it('reads columns as series and rows as categories, from cached values', () => {
    const data = ok(chartData(BUDGET, { type: 'bar', range: 'A1:C4', headers: true, labels: true }));
    expect(data.categories).toEqual(['Jan', 'Feb', 'Mar']);
    expect(data.series.map((s) => s.name)).toEqual(['Rent', 'Food']);
    expect(data.series[0].values).toEqual([1450, 1450, 1500]);
    expect(data.series[0].shown).toEqual(['$1,450', '1450', '1500']);
    // Text and errors are gaps.
    expect(data.series[1].values).toEqual([300, null, null]);
    expect(data.percent).toBe(false);
  });

  it('numbers categories and names series by column without headers or labels', () => {
    const data = ok(chartData(BUDGET, { type: 'line', range: 'B2:C4' }));
    expect(data.categories).toEqual(['2', '3', '4']);
    expect(data.series.map((s) => s.name)).toEqual(['Column B', 'Column C']);
  });

  it('explains what it cannot chart', () => {
    expect(chartData(BUDGET, { type: 'bar' })).toEqual({ ok: false, message: 'The chart has no range.' });
    expect(chartData(BUDGET, { type: 'bar', range: 'nope' })).toEqual({ ok: false, message: '“nope” is not a range.' });
    expect(chartData(BUDGET, { type: 'bar', range: 'A1:A4', labels: true })).toMatchObject({ ok: false });
    expect(chartData(BUDGET, { type: 'bar', range: 'A1:A4' })).toEqual({ ok: false, message: 'A1:A4 holds no numbers to chart.' });
  });

  it('limits the series to the eight colours and says how many it left out', () => {
    const wide: Record<string, SheetCell> = {};
    for (let c = 0; c < 10; c++) wide[String.fromCharCode(65 + c) + '1'] = { v: c };
    const data = ok(chartData(sheet(wide), { type: 'bar', range: 'A1:J1' }));
    expect(data.series).toHaveLength(MAX_SERIES);
    expect(data.hiddenSeries).toBe(2);
  });

  it('marks percentages so the axis shows them', () => {
    const s = sheet({ A1: { v: 0.25, fmt: '0%' }, A2: { v: 0.5, fmt: '0%' } });
    expect(ok(chartData(s, { type: 'line', range: 'A1:A2' })).percent).toBe(true);
  });
});

describe('guessChartOptions', () => {
  it('finds headers above the values and labels beside them', () => {
    expect(guessChartOptions(BUDGET, { col: 0, row: 0, width: 3, height: 4 })).toEqual({ headers: true, labels: true });
    expect(guessChartOptions(BUDGET, { col: 1, row: 1, width: 1, height: 3 })).toEqual({ headers: false, labels: false });
    expect(guessChartOptions(BUDGET, { col: 1, row: 0, width: 1, height: 4 })).toEqual({ headers: true, labels: false });
  });
});

describe('pieSlices', () => {
  it('takes the positive values of the first series with their shares', () => {
    const data = ok(chartData(BUDGET, { type: 'pie', range: 'A1:B4', headers: true, labels: true }));
    const slices = pieSlices(data);
    expect(slices.map((s) => s.label)).toEqual(['Jan', 'Feb', 'Mar']);
    expect(slices.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1);
  });

  it('sums the smallest slices beyond the limit as Other', () => {
    const cells: Record<string, SheetCell> = {};
    for (let i = 1; i <= 10; i++) {
      cells[`A${i}`] = { v: `k${i}` };
      cells[`B${i}`] = { v: i };
    }
    cells.B11 = { v: -5 };
    const slices = pieSlices(ok(chartData(sheet(cells), { type: 'pie', range: 'A1:B11', labels: true })));
    expect(slices).toHaveLength(8);
    expect(slices[7]).toMatchObject({ label: 'Other', value: 1 + 2 + 3 });
  });
});

describe('axis ticks', () => {
  it('rounds to clean steps and includes zero', () => {
    expect(niceTicks(0, 1500)).toEqual([0, 500, 1000, 1500]);
    expect(niceTicks(-3, 7)).toEqual([-4, -2, 0, 2, 4, 6, 8]);
    expect(niceTicks(5, 5)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(niceTicks(0.1, 0.9)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
  });

  it('labels ticks compactly', () => {
    expect(tickLabel(1500, false)).toBe('1.5K');
    expect(tickLabel(2_500_000, false)).toBe('2.5M');
    expect(tickLabel(-1000, false)).toBe('-1K');
    expect(tickLabel(0.25, true)).toBe('25%');
    expect(tickLabel(12, false)).toBe('12');
  });
});
