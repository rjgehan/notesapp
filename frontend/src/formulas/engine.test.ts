import { describe, expect, it } from 'vitest';
import { computeNote } from './engine';
import type { FormulaTable } from './model';

const budget: FormulaTable = {
  name: 'budget',
  named: true,
  rows: [
    ['Item', 'Cost'],
    ['Rent', '1450'],
    ['Utilities', '210'],
    ['Internet', '65'],
    ['**Total**', '=SUM(B2:B4)'],
  ],
  formats: {},
};

describe('note formulas engine (ROADMAP 39)', () => {
  it('computes a table cell with the sheets’ engine; plain cells keep their Markdown', () => {
    const r = computeNote({ tables: [budget] });
    expect(r.cell(0, 4, 1)).toMatchObject({ text: '1725', className: 'cm-formula-value', title: '=SUM(B2:B4)' });
    expect(r.cell(0, 1, 1)).toBeNull();
    expect(r.cell(0, 0, 0)).toBeNull();
  });

  it('shows errors with their code and message', () => {
    const t: FormulaTable = { name: 'Table1', named: false, rows: [['a', 'b'], ['1', '=A2/0'], ['=FOO(1)', '=SUM(']], formats: {} };
    const r = computeNote({ tables: [t] });
    expect(r.cell(0, 1, 1)).toMatchObject({ text: '#DIV/0!', className: 'cm-formula-error' });
    expect(r.cell(0, 1, 1)?.title).toContain('Division by zero');
    expect(r.cell(0, 2, 0)?.text).toBe('#NAME?');
    expect(r.cell(0, 2, 1)?.text).toBe('#ERROR!');
  });

  it('evaluates inline formulas, with references to named tables (39b)', () => {
    const r = computeNote({ tables: [budget] });
    expect(r.inline('=1450*12')?.text).toBe('17,400');
    expect(r.inline('=budget!B5')?.text).toBe('1725');
    expect(r.inline('=SUM(budget!B2:B4)*12')?.text).toBe('20,700');
    expect(r.inline('=IF(budget!B5>1000, "over", "ok")')?.text).toBe('over');
    expect(r.inline('=1/0')?.text).toBe('#DIV/0!');
    // Dataview's inline queries stay code.
    expect(r.inline('= this.file.name')).toBeNull();
    expect(r.inline('=SUM(')).toBeNull();
  });

  it('references other tables, applies column formats and the formats of result types', () => {
    const other: FormulaTable = { name: 'Table2', named: false, rows: [['Year', 'Share'], ['=budget!B5*12', '=0.25'], ['=DATE(2026,10,17)', '0.5']], formats: { 1: '0.0%' } };
    const r = computeNote({ tables: [budget, other] });
    expect(r.cell(1, 1, 0)?.text).toBe('20,700');
    expect(r.cell(1, 1, 1)?.text).toBe('25.0%');
    // A plain number in a formatted column shows formatted.
    expect(r.cell(1, 2, 1)?.text).toBe('50.0%');
    expect(r.cell(1, 2, 0)?.text).toBe('2026-10-17');
  });

  it('formats currency the engine recognizes, and spills array results into empty cells', () => {
    const t: FormulaTable = { name: 'Table1', named: false, rows: [['a', 'b'], ['$5', '=A2*2'], ['=SEQUENCE(2)', ''], ['', '']], formats: {} };
    const r = computeNote({ tables: [t] });
    expect(r.cell(0, 1, 1)?.text).toBe('$10.00');
    expect(r.cell(0, 2, 0)?.text).toBe('1');
    expect(r.cell(0, 3, 0)?.text).toBe('2');
    expect(r.cell(0, 3, 1)).toBeNull();
  });

  it('gives scripts raw values (ROADMAP 40b)', () => {
    const r = computeNote({ tables: [budget] });
    expect(r.evaluate('=budget!B5')).toBe(1725);
    expect(r.evaluate('=UPPER("x")')).toBe('X');
    expect(r.evaluate('=1/0')).toMatchObject({ error: '#DIV/0!' });
  });
});
