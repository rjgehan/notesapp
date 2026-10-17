// The quick-add parser is a lazy chunk (chrono-node and rrule come with it).
import type * as Parser from './parse';

export type ParserModule = typeof Parser;

let parserLoad: Promise<ParserModule> | null = null;

/** Loads the parser chunk once (also ahead of time, when a task page opens). */
export function loadParser(): Promise<ParserModule> {
  parserLoad ??= import('./parse');
  return parserLoad;
}
