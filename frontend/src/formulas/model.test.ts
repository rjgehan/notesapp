import { describe, expect, it } from 'vitest';
import { engineInput, formatAuto, formulasOff, isFormula, parseFormatsLine, sheetNames, tableAnnotations, tableNeedsEngine } from './model';

describe('formula model (ROADMAP 39)', () => {
  it('reads a formula as text that starts with = (not a highlight)', () => {
    expect(isFormula('=SUM(B2:B4)')).toBe(true);
    expect(isFormula('  =1+1 ')).toBe(true);
    expect(isFormula('=')).toBe(false);
    expect(isFormula('==important==')).toBe(false);
    expect(isFormula('a = b')).toBe(false);
  });

  it('gives the engine numbers without Markdown and thousands separators', () => {
    expect(engineInput('1450')).toBe('1450');
    expect(engineInput('**1,450**')).toBe('1450');
    expect(engineInput('-$12,000.50')).toBe('-$12000.50');
    expect(engineInput('Rent')).toBe('Rent');
    expect(engineInput('')).toBeNull();
    expect(engineInput('=B2*2')).toBe('=B2*2');
    // Text that only reads as a formula once unwrapped stays text.
    expect(engineInput('**=B2**')).toBe("'=B2");
    expect(engineInput('\\*x')).toBe('*x');
  });

  it('reads the block id and formats under a table after a blank line', () => {
    expect(tableAnnotations(['', '^budget', '%% formats: B=currency C=0.0% %%'])).toEqual({ id: 'budget', formats: { 1: '$#,##0.00', 2: '0.0%' } });
    expect(tableAnnotations(['', '%% formats B=percent %%', '^x'])).toEqual({ id: 'x', formats: { 1: '0.00%' } });
    // A line right under a table is one of its rows; other text ends the search.
    expect(tableAnnotations(['^budget'])).toEqual({ id: null, formats: {} });
    expect(tableAnnotations(['', 'Some text', '^budget'])).toEqual({ id: null, formats: {} });
    expect(parseFormatsLine('%% not formats %%')).toBeNull();
    expect(parseFormatsLine('%% formats: D=#,##0 1=x B= %%')).toEqual({ 3: '#,##0' });
  });

  it('names tables by block id, else Table1, Table2, … without clashing', () => {
    expect(sheetNames([null, 'budget', null])).toEqual(['Table1', 'budget', 'Table3']);
    expect(sheetNames(['Table2', null, null])).toEqual(['Table2', 'Table3', 'Table4']);
    expect(sheetNames(['a', 'A'])).toEqual(['a', 'Table2']);
  });

  it('turns formulas off with formulas: false in the frontmatter', () => {
    expect(formulasOff('---\ntitle: x\nformulas: false\n---')).toBe(true);
    expect(formulasOff('formulas: no # literal = signs')).toBe(true);
    expect(formulasOff('formulas: true')).toBe(false);
    expect(formulasOff(null)).toBe(false);
  });

  it('formats numbers as the sheets do, grouping from five digits', () => {
    expect(formatAuto(1725)).toBe('1725');
    expect(formatAuto(17400)).toBe('17,400');
    expect(formatAuto(-1234567.25)).toBe('-1,234,567.25');
    expect(formatAuto(0.1 + 0.2)).toBe('0.3');
    expect(formatAuto(1e20)).toBe('1E+20');
  });

  it('needs the engine only for formulas or column formats', () => {
    expect(tableNeedsEngine({ rows: [['a'], ['1']], formats: {} })).toBe(false);
    expect(tableNeedsEngine({ rows: [['a'], ['=1']], formats: {} })).toBe(true);
    expect(tableNeedsEngine({ rows: [['a'], ['1']], formats: { 0: '0%' } })).toBe(true);
  });
});
