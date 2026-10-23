import { describe, expect, it } from 'vitest';
import { signatureParts } from './formulaText';
import { friendlyError, functionCatalog } from './functions';

const signature = (name: string) => {
  const info = functionCatalog().find((f) => f.name === name)!;
  return signatureParts(info, -1)
    .map((p) => p.text)
    .join('');
};

describe('the engine’s functions for the formula help', () => {
  it('lists the engine’s functions with their parameters', () => {
    const names = functionCatalog().map((f) => f.name);
    expect(names.length).toBeGreaterThan(300);
    expect(names).toEqual(expect.arrayContaining(['SUM', 'SUMIF', 'VLOOKUP', 'TODAY', 'STDEV']));
    expect(signature('SUM')).toBe('SUM(value1, [value2, …])');
    expect(signature('IF')).toBe('IF(condition, value_if_true, [value_if_false])');
    expect(signature('VLOOKUP')).toBe('VLOOKUP(search_key, range, index, [is_sorted])');
    expect(signature('TODAY')).toBe('TODAY()');
    expect(signature('COUNTIFS')).toBe('COUNTIFS(criteria_range1, criterion1, [criteria_range2, criterion2, …])');
    // Functions without names of their own take names from their parameters' types.
    expect(signature('ATAN2')).toBe('ATAN2(number1, number2)');
  });

  it('explains #NAME? for a function written without its brackets', () => {
    expect(friendlyError('#NAME?', '=SUM', 'Named expression SUM not recognized.')).toBe('Did you mean SUM(…)?');
    expect(friendlyError('#NAME?', '=SUMM(1)', 'Function name SUMM not recognized.')).toBe('Unknown function SUMM. Did you mean SUM?');
    expect(friendlyError('#ERROR!', '=SUM(B2:B4', 'Parsing error.')).toBe('Missing a closing bracket )');
    expect(friendlyError('#DIV/0!', '=1/0', 'Division by zero.')).toBe('Division by zero.');
  });
});
