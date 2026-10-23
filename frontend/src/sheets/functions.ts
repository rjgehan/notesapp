// The engine's functions as the formula help shows them (DESIGN §6.21.5, §6.42): names for
// autocomplete and signatures for the hint. HyperFormula knows each function's parameters (their
// types, which are optional, which repeat) but not their names, so the common functions get the
// names Google Sheets uses and the rest a name from the type (`number`, `range`, `value`).
// Part of the engines' lazy chunks: only engine.ts (sheets) and formulas/engine.ts import it.
import { HyperFormula } from 'hyperformula';
import { nameHint, type FunctionInfo } from './formulaText';

/** Parameter names of the common functions; the first ones listed also come first among suggestions. */
const NAMED: Record<string, string> = {
  SUM: 'value',
  AVERAGE: 'value',
  COUNT: 'value',
  COUNTA: 'value',
  MIN: 'value',
  MAX: 'value',
  IF: 'condition, value_if_true, value_if_false',
  ROUND: 'value, places',
  SUMIF: 'range, criterion, sum_range',
  COUNTIF: 'range, criterion',
  AVERAGEIF: 'range, criterion, average_range',
  IFERROR: 'value, value_if_error',
  VLOOKUP: 'search_key, range, index, is_sorted',
  HLOOKUP: 'search_key, range, index, is_sorted',
  XLOOKUP: 'search_key, lookup_range, result_range, missing_value, match_mode, search_mode',
  INDEX: 'reference, row, column',
  MATCH: 'search_key, range, search_type',
  AND: 'logical',
  OR: 'logical',
  NOT: 'logical',
  CONCATENATE: 'string',
  TEXT: 'number, format',
  LEN: 'text',
  TODAY: '',
  NOW: '',
  DATE: 'year, month, day',
  ABS: 'value',
  PRODUCT: 'factor',
  MEDIAN: 'value',
  SUMPRODUCT: 'array',
  ROUNDUP: 'value, places',
  ROUNDDOWN: 'value, places',
  SUMIFS: 'sum_range, criteria_range, criterion',
  COUNTIFS: 'criteria_range, criterion',
  AVERAGEIFS: 'average_range, criteria_range, criterion',
  IFS: 'condition, value',
  LEFT: 'string, number_of_characters',
  RIGHT: 'string, number_of_characters',
  MID: 'string, starting_at, extract_length',
  UPPER: 'text',
  LOWER: 'text',
  TRIM: 'text',
  SUBSTITUTE: 'text, search_for, replace_with, occurrence',
  POWER: 'base, exponent',
  SQRT: 'value',
  MOD: 'dividend, divisor',
  INT: 'value',
  YEAR: 'date',
  MONTH: 'date',
  DAY: 'date',
  WEEKDAY: 'date, type',
  DATEDIF: 'start_date, end_date, unit',
  EDATE: 'start_date, months',
  EOMONTH: 'start_date, months',
  NETWORKDAYS: 'start_date, end_date, holidays',
  PMT: 'rate, number_of_periods, present_value, future_value, end_or_beginning',
  SEQUENCE: 'rows, columns, start, step',
  FILTER: 'range, condition',
  SORT: 'range, sort_column, is_ascending',
  UNIQUE: 'range',
  STDEV: 'value',
  RANK: 'value, data, is_ascending',
  LARGE: 'data, n',
  SMALL: 'data, n',
  ISBLANK: 'value',
  ISNUMBER: 'value',
  CHOOSE: 'index, choice',
  SWITCH: 'expression, case, value',
};

const RANKS = new Map(Object.keys(NAMED).map((name, i) => [name, i]));

const BY_TYPE: Record<string, string> = {
  NUMBER: 'number',
  INTEGER: 'integer',
  STRING: 'text',
  BOOLEAN: 'logical',
  RANGE: 'range',
  COMPLEX: 'number',
};

interface Metadata {
  parameters?: Array<{ argumentType: string; optionalArg?: boolean; defaultValue?: unknown }>;
  repeatLastArgs?: number;
}

interface PluginLike {
  implementedFunctions?: Record<string, Metadata>;
  aliases?: Record<string, string>;
}

function infoOf(name: string): FunctionInfo {
  const plugin = HyperFormula.getFunctionPlugin(name) as unknown as PluginLike | undefined;
  const canonical = plugin?.aliases?.[name] ?? name;
  const meta = plugin?.implementedFunctions?.[canonical];
  const params = meta?.parameters ?? [];
  const named = NAMED[name]?.split(', ').filter((n) => n !== '');
  const typeNames = params.map((p) => BY_TYPE[p.argumentType] ?? 'value');
  const counts = new Map<string, number>();
  for (const n of typeNames) counts.set(n, (counts.get(n) ?? 0) + 1);
  const seen = new Map<string, number>();
  const repeat = meta?.repeatLastArgs ?? 0;
  const fixed = params.length - repeat;
  return {
    name,
    params: params.map((p, i) => {
      let label = named?.[i];
      if (!label) {
        label = typeNames[i];
        // Two numbers become number1 and number2, except in the repeated group, whose names get numbers anyway.
        if ((counts.get(label) ?? 0) > 1 && i < fixed) {
          const k = (seen.get(label) ?? 0) + 1;
          seen.set(label, k);
          label = `${label}${k}`;
        }
      }
      return { name: label, optional: p.optionalArg === true || p.defaultValue !== undefined };
    }),
    repeat,
    rank: RANKS.get(name),
  };
}

let catalog: FunctionInfo[] | null = null;
let names: Set<string> | null = null;

/** Every function of the engine (cached). */
export function functionCatalog(): readonly FunctionInfo[] {
  catalog ??= HyperFormula.getRegisteredFunctionNames('enGB')
    .filter((n) => !n.startsWith('_') && !n.includes('HF.'))
    .map(infoOf);
  return catalog;
}

function functionNames(): ReadonlySet<string> {
  names ??= new Set(functionCatalog().map((f) => f.name));
  return names;
}

/** The explanation of an error result: for `#NAME?`, what was probably meant (`=SUM`: "Did you mean SUM(…)?"), else `message`. */
export function friendlyError(code: string, formula: string | null | undefined, message: string): string {
  if (code === '#NAME?' && formula) return nameHint(formula, functionNames()) ?? message;
  return message;
}
