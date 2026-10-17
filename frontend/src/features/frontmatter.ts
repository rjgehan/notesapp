// Frontmatter detection (DESIGN §5.5.3): line 0 is exactly `---` (trailing whitespace allowed)
// and a later line is exactly `---`. An unterminated block is not frontmatter.
import { parse } from 'yaml';

export interface FrontmatterSplit {
  /** The YAML source between the delimiters, or null when there is no frontmatter. */
  yaml: string | null;
  /** Text after the closing delimiter line. */
  body: string;
  /** Number of lines before the body (the frontmatter block, both delimiters included). */
  lineOffset: number;
  /** Offset of the body in the text. */
  bodyStart: number;
}

const DELIMITER = /^---[ \t]*\r?$/;

export function splitFrontmatter(text: string): FrontmatterSplit {
  const firstBreak = text.indexOf('\n');
  if (firstBreak < 0 || !DELIMITER.test(text.slice(0, firstBreak))) return { yaml: null, body: text, lineOffset: 0, bodyStart: 0 };
  let lineStart = firstBreak + 1;
  let line = 1;
  while (lineStart <= text.length) {
    const end = text.indexOf('\n', lineStart);
    const lineEnd = end < 0 ? text.length : end;
    if (DELIMITER.test(text.slice(lineStart, lineEnd))) {
      const bodyStart = end < 0 ? text.length : end + 1;
      return { yaml: text.slice(firstBreak + 1, lineStart), body: text.slice(bodyStart), lineOffset: line + 1, bodyStart };
    }
    if (end < 0) break;
    lineStart = end + 1;
    line++;
  }
  return { yaml: null, body: text, lineOffset: 0, bodyStart: 0 };
}

export interface ParsedFrontmatter {
  data: Record<string, unknown> | null;
  error: string | null;
}

/** YAML 1.2 core schema; dates stay strings, as on the server. */
export function parseFrontmatter(yaml: string): ParsedFrontmatter {
  try {
    const data: unknown = parse(yaml, { schema: 'core', uniqueKeys: false });
    if (data === null || data === undefined) return { data: {}, error: null };
    if (typeof data !== 'object' || Array.isArray(data)) return { data: null, error: 'Frontmatter is not a mapping' };
    return { data: data as Record<string, unknown>, error: null };
  } catch (e) {
    return { data: null, error: e instanceof Error ? e.message : String(e) };
  }
}
