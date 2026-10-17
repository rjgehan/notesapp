// Live Preview tables (DESIGN §6.6.1, ROADMAP 10a): a GFM table's source as an editable model, and
// back. The model keeps every byte of the source (each cell's text as written, and the whitespace
// and pipes around it), so an untouched table serializes to exactly its text, and an edit rewrites
// only what it changes, in the table's own style: a padded table stays padded, a compact one
// compact. Rows split into cells exactly as the Lezer parser (and GFM) split them; a cell's content
// is its raw Markdown with `\|` unescaped. Pure and DOM-free.
import { markdownLanguage } from '@codemirror/lang-markdown';

export type Align = 'left' | 'center' | 'right' | null;

/** A cell as written: its text (pipes escaped) and the whitespace on either side. */
export interface CellSource {
  before: string;
  text: string;
  after: string;
}

/** One line of a table. */
export interface RowSource {
  /** Whitespace before the row. */
  indent: string;
  /** The row starts with a pipe. */
  lead: boolean;
  cells: CellSource[];
  /** A pipe follows the last cell. */
  trail: boolean;
  /** Whitespace after the last pipe. */
  end: string;
}

/** Where a padded column's cells put their padding: after the text, before it, or around it. */
export type Justify = 'start' | 'end' | 'center';

export interface TableStyle {
  /** Every row has every cell and the pipes line up: edits keep the columns padded. */
  padded: boolean;
  /** Spaces between a pipe and a cell's text. */
  margin: number;
  /** A padded delimiter row fills each cell with dashes (`|:----|`) rather than padding it (`| :-- |`). */
  fillDelimiter: boolean;
  /** Per column, for padded tables. */
  justify: Justify[];
}

export interface TableModel {
  header: RowSource;
  delimiter: RowSource;
  body: RowSource[];
  /** The header's cell count; GFM requires the delimiter row to match. */
  columns: number;
  /** Per column, from the delimiter row. */
  align: Align[];
  style: TableStyle;
}

/** The narrowest column a padded table gets (`---`, room for `:-:`), as Markdown table formatters do. */
const MIN_COLUMN_WIDTH = 3;

const DELIMITER_CELL = /^:?-+:?$/;

function isBlank(s: string): boolean {
  return /^[ \t]*$/.test(s);
}

// ---------- display width ----------

const WIDE = /[\u1100-\u115F\u231A\u231B\u2329\u232A\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{20000}-\u{3FFFD}]|\p{Emoji_Presentation}/u;
const ZERO = /^(?:\p{M}|[\u200B-\u200F\uFEFF])+$/u;
const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** The width of `s` in a monospace font: wide East Asian characters and emoji take two columns. */
export function displayWidth(s: string): number {
  // ASCII, the common case, is one column per character.
  if (/^[\x20-\x7e]*$/.test(s)) return s.length;
  const graphemes = segmenter ? Array.from(segmenter.segment(s), (g) => g.segment) : Array.from(s);
  let width = 0;
  for (const g of graphemes) width += ZERO.test(g) ? 0 : WIDE.test(g) ? 2 : 1;
  return width;
}

// ---------- parsing ----------

/**
 * Splits a cell's part of a row into its text and the whitespace around it, as Lezer does: an
 * escaped character is text, even a space.
 */
function cellOf(part: string): CellSource {
  let start = -1;
  let end = -1;
  let esc = false;
  for (let i = 0; i < part.length; i++) {
    const ch = part.charCodeAt(i);
    if (esc || (ch !== 32 && ch !== 9)) {
      if (start < 0) start = i;
      end = i + 1;
    }
    esc = !esc && ch === 92;
  }
  if (start < 0) return { before: part, text: '', after: '' };
  return { before: part.slice(0, start), text: part.slice(start, end), after: part.slice(end) };
}

/**
 * One line of a table, split at its unescaped pipes as Lezer's `parseRow` splits it: a pipe before
 * any text and a pipe after all of it are outer pipes, not cell boundaries.
 */
export function parseRow(line: string): RowSource {
  const indent = /^[ \t]*/.exec(line)![0];
  const body = line.slice(indent.length);
  const parts: string[] = [];
  let start = 0;
  let esc = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body.charCodeAt(i);
    if (ch === 124 && !esc) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
    esc = !esc && ch === 92;
  }
  parts.push(body.slice(start));
  const pipes = parts.length - 1;
  const lead = pipes > 0 && isBlank(parts[0]);
  const lastIsCell = pipes === 0 || !isBlank(parts[pipes]);
  const from = lead ? 1 : 0;
  const to = Math.max(from, lastIsCell ? pipes + 1 : pipes);
  return {
    indent,
    lead,
    cells: parts.slice(from, to).map(cellOf),
    // A lone pipe (`|`) is the row's only pipe: it leads, and nothing trails.
    trail: !lastIsCell && (pipes >= 2 || !lead),
    end: lastIsCell ? '' : parts[pipes],
  };
}

function hasPipe(row: RowSource): boolean {
  return row.lead || row.trail || row.cells.length > 1;
}

function alignOf(text: string): Align {
  const left = text.startsWith(':');
  const right = text.length > 1 && text.endsWith(':');
  return left && right ? 'center' : left ? 'left' : right ? 'right' : null;
}

function segment(cell: CellSource): string {
  return cell.before + cell.text + cell.after;
}

function detectStyle(header: RowSource, delimiter: RowSource, body: RowSource[], columns: number): TableStyle {
  const content = [header, ...body];
  const all = [header, delimiter, ...body];
  // The fewest spaces between a pipe and a cell's text (the outer edges of rows without outer
  // pipes do not count).
  let margin = Infinity;
  for (const row of content) {
    row.cells.forEach((cell, i) => {
      if (cell.text === '') return;
      if (i > 0 || row.lead) margin = Math.min(margin, cell.before.length);
      if (i < row.cells.length - 1 || row.trail) margin = Math.min(margin, cell.after.length);
    });
  }
  if (!Number.isFinite(margin)) margin = 1;
  const width = (cell: CellSource) => displayWidth(segment(cell));
  // Padding tables is what formatters do; they write outer pipes. A table without them whose
  // pipes happen to line up is edited as a compact one.
  let padded = all.every(
    (r) => r.cells.length === columns && r.lead && r.trail && r.indent === header.indent && !r.cells.some((c) => /\t/.test(c.before + c.after)),
  );
  for (let i = 0; padded && i < columns; i++) {
    const w = width(header.cells[i]);
    padded = all.every((r) => width(r.cells[i]) === w);
  }
  const justify = Array.from({ length: columns }, (_, i): Justify => {
    if (!padded) return 'start';
    const cells = content.map((r) => r.cells[i]).filter((c) => c.text !== '' && c.before.length + c.after.length > 2 * margin);
    if (cells.length === 0 || cells.every((c) => c.before.length === margin)) return 'start';
    if (cells.every((c) => c.after.length === margin)) return 'end';
    return 'center';
  });
  return { padded, margin, fillDelimiter: delimiter.cells.every((c) => c.before === '' && c.after === ''), justify };
}

/**
 * The model of a table's source (the lines of a Lezer `Table` node, from the start of its first
 * line), or null when the text is not a table: no delimiter row matching the header's cells, or a
 * blank line.
 */
export function parseTable(text: string): TableModel | null {
  const lines = text.split('\n');
  if (lines.length < 2 || lines.some(isBlank)) return null;
  const header = parseRow(lines[0]);
  const delimiter = parseRow(lines[1]);
  const columns = header.cells.length;
  // Lezer reads no delimiter row with whitespace after its last pipe.
  if (columns === 0 || delimiter.cells.length !== columns || !hasPipe(header) || !hasPipe(delimiter) || delimiter.end !== '') return null;
  if (!delimiter.cells.every((c) => DELIMITER_CELL.test(c.text))) return null;
  const body = lines.slice(2).map(parseRow);
  return { header, delimiter, body, columns, align: delimiter.cells.map((c) => alignOf(c.text)), style: detectStyle(header, delimiter, body, columns) };
}

// ---------- serializing ----------

export function serializeRow(row: RowSource): string {
  return row.indent + (row.lead ? '|' : '') + row.cells.map(segment).join('|') + (row.trail ? '|' : '') + row.end;
}

/** The table's text: byte for byte its source when nothing was edited. */
export function serializeTable(m: TableModel): string {
  return [m.header, m.delimiter, ...m.body].map(serializeRow).join('\n');
}

/** Where each cell of the grid starts and ends in the table's text (`row` 0 is the header; the delimiter row has none). */
export interface CellSpan {
  row: number;
  column: number;
  /** The cell between its pipes, whitespace included. */
  from: number;
  to: number;
}

export function cellSpans(m: TableModel): CellSpan[] {
  const out: CellSpan[] = [];
  let pos = 0;
  [m.header, m.delimiter, ...m.body].forEach((row, line) => {
    let at = pos + row.indent.length + (row.lead ? 1 : 0);
    row.cells.forEach((cell, column) => {
      const to = at + segment(cell).length;
      if (line !== 1) out.push({ row: line === 0 ? 0 : line - 1, column, from: at, to });
      at = to + 1;
    });
    pos += serializeRow(row).length + 1;
  });
  return out;
}

// ---------- contents ----------

/** A cell's content from its text as written: `\|` is a pipe inside the cell. */
export function unescapeCell(text: string): string {
  return text.replace(/\\\|/g, '|');
}

/**
 * A cell's text for its content: a pipe gets a backslash, so it stays inside the cell. A pipe
 * already after an odd number of backslashes is escaped (`\|`) and stays as typed.
 */
export function escapeCell(content: string): string {
  return content.replace(/(\\*)\|/g, (match, slashes: string) => (slashes.length % 2 === 0 ? `${slashes}\\|` : match));
}

export function rowCount(m: TableModel): number {
  return m.body.length + 1;
}

function rowAt(m: TableModel, row: number): RowSource {
  return row === 0 ? m.header : m.body[row - 1];
}

/** The content of a grid cell (`row` 0 is the header); a cell missing from a short row is empty. */
export function cellContent(m: TableModel, row: number, column: number): string {
  const cell = rowAt(m, row)?.cells[column];
  return cell ? unescapeCell(cell.text) : '';
}

/** The grid's contents: the header row, then the body rows, each with exactly `columns` cells. */
export function gridRows(m: TableModel): string[][] {
  return [m.header, ...m.body].map((row) => Array.from({ length: m.columns }, (_, c) => (row.cells[c] ? unescapeCell(row.cells[c].text) : '')));
}

// ---------- checking ----------

const tableParser = markdownLanguage.parser;

/**
 * Whether `text` is the table `m` describes: Lezer reads every line as one table, and the rows
 * split into exactly the model's cells. Every edit is checked before it is written, so a bug or an
 * unforeseen input can refuse an edit but never corrupt a note.
 */
export function isSerializationOf(m: TableModel, text: string): boolean {
  const parsed = parseTable(text);
  if (!parsed || parsed.columns !== m.columns || parsed.body.length !== m.body.length) return false;
  const rows = [m.header, m.delimiter, ...m.body];
  const again = [parsed.header, parsed.delimiter, ...parsed.body];
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i].cells.map(segment);
    const b = again[i].cells.map(segment);
    if (a.length !== b.length || a.some((s, j) => s !== b[j])) return false;
  }
  const table = tableParser.parse(text).topNode.firstChild;
  return table !== null && table.name === 'Table' && table.from === parsed.header.indent.length && table.to === text.length;
}

// ---------- editing ----------

function blankCell(margin: number): CellSource {
  return { before: ' '.repeat(Math.max(1, 2 * margin)), text: '', after: '' };
}

function marginCell(text: string, margin: number): CellSource {
  const m = ' '.repeat(margin);
  return text === '' ? blankCell(margin) : { before: m, text, after: m };
}

/**
 * Text that could start another block at the start of a line (a heading, a quote, a list, code,
 * HTML), which would end the table there. Deliberately broad.
 */
const BLOCK_START = /^(?:[#>+*`~<-]|\d+[.)])/;

/** An edge cell that gets a pipe on a side that had none gets the table's margin there. */
function inward(cell: CellSource, side: 'before' | 'after', margin: number): CellSource {
  return cell.text !== '' && cell[side] === '' ? { ...cell, [side]: ' '.repeat(margin) } : cell;
}

/**
 * Keeps a rewritten row a row of its table: an outer pipe where a blank edge cell or block markup
 * at the line start would change how the line parses, at least one pipe, and a space between a
 * cell ending in a backslash and the pipe after it (which `\|` would escape).
 */
function settleRow(row: RowSource, margin: number, delimiter = false): RowSource {
  if (row.cells.length === 0) return row;
  const n = row.cells.length;
  const lead = row.lead || row.cells[0].text === '' || (!delimiter && BLOCK_START.test(row.cells[0].text));
  const piped = withOuterPipes(row, lead, row.trail || row.cells[n - 1].text === '' || (!lead && n === 1), margin);
  const cells = piped.cells.map((c, i): CellSource => {
    // Without an outer pipe, whitespace before the first cell is the row's indentation.
    if (i === 0 && !piped.lead && c.before !== '') c = { ...c, before: '' };
    const pipeAfter = i < n - 1 || piped.trail;
    return pipeAfter && c.after === '' && /\\*$/.exec(c.text)![0].length % 2 === 1 ? { ...c, after: ' ' } : c;
  });
  return { ...piped, cells };
}

/** Gives a row outer pipes; the edge cells get the table's margin inside them. */
function withOuterPipes(row: RowSource, lead: boolean, trail: boolean, margin: number): RowSource {
  const cells = [...row.cells];
  if (lead && !row.lead && cells.length > 0) cells[0] = inward(cells[0], 'before', margin);
  if (trail && !row.trail && cells.length > 0) cells[cells.length - 1] = inward(cells[cells.length - 1], 'after', margin);
  return { ...row, cells, lead: row.lead || lead, trail: row.trail || trail };
}

function padCell(text: string, width: number, margin: number, justify: Justify): CellSource {
  const extra = Math.max(0, width - displayWidth(text));
  const m = ' '.repeat(margin);
  if (justify === 'end') return { before: m + ' '.repeat(extra), text, after: m };
  if (justify === 'center') {
    const left = Math.floor(extra / 2);
    return { before: m + ' '.repeat(left), text, after: ' '.repeat(extra - left) + m };
  }
  return { before: m, text, after: ' '.repeat(extra) + m };
}

function delimiterText(align: Align, width: number): string {
  const left = align === 'left' || align === 'center';
  const right = align === 'right' || align === 'center';
  const dashes = Math.max(1, width - (left ? 1 : 0) - (right ? 1 : 0));
  return (left ? ':' : '') + '-'.repeat(dashes) + (right ? ':' : '');
}

function padDelimiter(align: Align, width: number, style: TableStyle): CellSource {
  if (style.fillDelimiter) return { before: '', text: delimiterText(align, width + 2 * style.margin), after: '' };
  const m = ' '.repeat(style.margin);
  return { before: m, text: delimiterText(align, width), after: m };
}

/** The text width of a padded table's column. */
function columnWidth(m: TableModel, column: number): number {
  return displayWidth(segment(m.header.cells[column])) - 2 * m.style.margin;
}

/** Pads `columns` of a padded table again, each to its widest content. */
function refit(m: TableModel, columns: Iterable<number>): TableModel {
  if (!m.style.padded) return m;
  const content = [m.header, ...m.body];
  let header = m.header;
  let delimiter = m.delimiter;
  let body = m.body;
  // A delimiter filling its cell (`|:-:|`) leaves room for the colons whatever the column's width.
  const narrowest = m.style.fillDelimiter ? Math.max(1, MIN_COLUMN_WIDTH - 2 * m.style.margin) : MIN_COLUMN_WIDTH;
  for (const c of columns) {
    const width = Math.max(narrowest, ...content.map((r) => displayWidth(r.cells[c]?.text ?? '')));
    const pad = (row: RowSource): RowSource => {
      const cells = [...row.cells];
      cells[c] = padCell(cells[c]?.text ?? '', width, m.style.margin, m.style.justify[c]);
      return settleRow({ ...row, cells }, m.style.margin);
    };
    header = pad(header);
    body = body.map(pad);
    const cells = [...delimiter.cells];
    cells[c] = padDelimiter(m.align[c], width, m.style);
    delimiter = settleRow({ ...delimiter, cells }, m.style.margin, true);
  }
  return { ...m, header, delimiter, body };
}

function withRow(m: TableModel, row: number, source: RowSource): TableModel {
  if (row === 0) return { ...m, header: source };
  const body = [...m.body];
  body[row - 1] = source;
  return { ...m, body };
}

/** A cell's spacing as it was: the whitespace on each side of its text, and the text's width. */
export interface CellPad {
  before: string;
  after: string;
  width: number;
}

/**
 * Sets a cell's content (newlines become spaces; pipes are escaped). A padded table pads the
 * column again. Otherwise the cell keeps its spacing, or `pad` when given (the spacing it had when
 * its editing began), and padding after the text gives or takes the change in width, so a cell
 * that lined up still does while it fits. A short row gets the missing cells before it.
 */
export function setCell(m: TableModel, row: number, column: number, content: string, pad?: CellPad): TableModel {
  const source = rowAt(m, row);
  const text = escapeCell(content.replace(/\r?\n/g, ' '));
  const cells = [...source.cells];
  while (cells.length <= column) cells.push(blankCell(m.style.margin));
  const old = cells[column];
  const base = pad ?? (old.text !== '' ? { before: old.before, after: old.after, width: displayWidth(old.text) } : null);
  if (base) {
    let after = base.after;
    if (/^ +$/.test(after) && after.length > m.style.margin) after = ' '.repeat(Math.max(m.style.margin, after.length - (displayWidth(text) - base.width)));
    cells[column] = { before: base.before, text, after };
  } else {
    cells[column] = marginCell(text, m.style.margin);
  }
  const next = withRow(m, row, settleRow({ ...source, cells }, m.style.margin));
  return refit(next, [column]);
}

function emptyRow(m: TableModel): RowSource {
  const cells = Array.from({ length: m.columns }, (_, c) => (m.style.padded ? padCell('', columnWidth(m, c), m.style.margin, 'start') : blankCell(m.style.margin)));
  return settleRow({ indent: m.header.indent, lead: m.header.lead, cells, trail: m.header.trail, end: '' }, m.style.margin);
}

/** Inserts an empty row so that it becomes grid row `at` (1 is the first body row; the header stays first). */
export function insertRow(m: TableModel, at: number): TableModel {
  const index = Math.min(Math.max(at, 1), rowCount(m)) - 1;
  const body = [...m.body];
  body.splice(index, 0, emptyRow(m));
  return { ...m, body };
}

/** Removes a body row (the header cannot be removed). */
export function deleteRow(m: TableModel, row: number): TableModel {
  if (row < 1 || row >= rowCount(m)) return m;
  const body = [...m.body];
  body.splice(row - 1, 1);
  return { ...m, body };
}

/** Moves a body row to grid row `to`; the header stays first. */
export function moveRow(m: TableModel, from: number, to: number): TableModel {
  const last = rowCount(m) - 1;
  if (from < 1 || from > last || to < 1 || to > last || from === to) return m;
  const body = [...m.body];
  const [moved] = body.splice(from - 1, 1);
  body.splice(to - 1, 0, moved);
  return { ...m, body };
}

function reorder<T>(items: readonly T[], f: (copy: T[]) => void): T[] {
  const copy = [...items];
  f(copy);
  return copy;
}

/** Inserts an empty column so that it becomes column `at`. Short rows that end before it are left as they are. */
export function insertColumn(m: TableModel, at: number): TableModel {
  const index = Math.min(Math.max(at, 0), m.columns);
  const { style } = m;
  const empty = (): CellSource => (style.padded ? padCell('', MIN_COLUMN_WIDTH, style.margin, 'start') : blankCell(style.margin));
  const insert = (row: RowSource, cell: CellSource, delimiter = false): RowSource => {
    if (index > row.cells.length) return row;
    const cells = [...row.cells];
    // An edge cell the new one pushes inward gets a pipe on its outer side.
    if (index === 0 && !row.lead && cells.length > 0) cells[0] = inward(cells[0], 'before', style.margin);
    if (index === cells.length && !row.trail && cells.length > 0) cells[index - 1] = inward(cells[index - 1], 'after', style.margin);
    cells.splice(index, 0, cell);
    return settleRow({ ...row, cells }, style.margin, delimiter);
  };
  const m0 = ' '.repeat(style.margin);
  const header = insert(m.header, empty());
  const delimiter = insert(m.delimiter, style.padded ? padDelimiter(null, MIN_COLUMN_WIDTH, style) : { before: m0, text: '-'.repeat(MIN_COLUMN_WIDTH), after: m0 }, true);
  return {
    ...m,
    header,
    // The delimiter row follows the outer pipes a blank new edge cell gave the header.
    delimiter: withOuterPipes(delimiter, header.lead, header.trail, style.margin),
    body: m.body.map((r) => insert(r, empty())),
    columns: m.columns + 1,
    align: reorder(m.align, (a) => a.splice(index, 0, null)),
    style: { ...style, justify: reorder(style.justify, (j) => j.splice(index, 0, 'start')) },
  };
}

/** Removes a column (a table keeps at least one). Short rows without the cell are left as they are. */
export function deleteColumn(m: TableModel, column: number): TableModel {
  if (m.columns <= 1 || column < 0 || column >= m.columns) return m;
  const remove = (row: RowSource, delimiter = false): RowSource =>
    column < row.cells.length ? settleRow({ ...row, cells: reorder(row.cells, (c) => c.splice(column, 1)) }, m.style.margin, delimiter) : row;
  return {
    ...m,
    header: remove(m.header),
    delimiter: remove(m.delimiter, true),
    body: m.body.map((r) => remove(r)),
    columns: m.columns - 1,
    align: reorder(m.align, (a) => a.splice(column, 1)),
    style: { ...m.style, justify: reorder(m.style.justify, (j) => j.splice(column, 1)) },
  };
}

/**
 * Moves column `from` to `to`. The cells' texts move and the spacing stays where it is (a padded
 * table pads the columns again). A short row gets the empty cells it needs; cells past the
 * header's stay put.
 */
export function moveColumn(m: TableModel, from: number, to: number): TableModel {
  if (from < 0 || from >= m.columns || to < 0 || to >= m.columns || from === to) return m;
  const move = <T>(items: readonly T[]): T[] =>
    reorder(items, (c) => {
      const [moved] = c.splice(from, 1);
      c.splice(to, 0, moved);
    });
  const low = Math.min(from, to);
  const reach = Math.max(from, to);
  const { margin } = m.style;
  const moveRowCells = (row: RowSource, delimiter = false): RowSource => {
    if (row.cells.length <= low) return row;
    const cells = [...row.cells];
    while (cells.length <= reach) cells.push(blankCell(margin));
    const texts = move(cells.slice(0, reach + 1).map((c) => c.text));
    const moved = cells.map((cell, i): CellSource => {
      if (i > reach || cell.text === texts[i]) return cell;
      const text = texts[i];
      if (cell.text === '') return { ...marginCell(text, margin), before: i === 0 && !row.lead ? '' : ' '.repeat(margin) };
      if (text === '') return { before: cell.before, text: '', after: cell.after };
      return { ...cell, text };
    });
    return settleRow({ ...row, cells: moved }, margin, delimiter);
  };
  const next = {
    ...m,
    header: moveRowCells(m.header),
    delimiter: moveRowCells(m.delimiter, true),
    body: m.body.map((r) => moveRowCells(r)),
    align: move(m.align),
    style: { ...m.style, justify: move(m.style.justify) },
  };
  return refit(next, Array.from({ length: reach - low + 1 }, (_, i) => low + i));
}

/** Sets a column's alignment marker in the delimiter row. */
export function setAlign(m: TableModel, column: number, align: Align): TableModel {
  if (column < 0 || column >= m.columns || m.align[column] === align) return m;
  const align2 = reorder(m.align, (a) => (a[column] = align));
  const cells = [...m.delimiter.cells];
  const old = cells[column];
  const dashes = Math.max(1, old.text.replace(/:/g, '').length);
  cells[column] = { ...old, text: (align === 'left' || align === 'center' ? ':' : '') + '-'.repeat(dashes) + (align === 'right' || align === 'center' ? ':' : '') };
  return refit({ ...m, align: align2, delimiter: { ...m.delimiter, cells } }, [column]);
}

/** The text of a new, empty table with `columns` columns and `rows` body rows, padded. */
export function newTableText(columns = 2, rows = 2): string {
  const line = (cell: string) => `|${Array.from({ length: columns }, () => cell).join('|')}|`;
  const empty = line(' '.repeat(MIN_COLUMN_WIDTH + 2));
  return [empty, line(` ${'-'.repeat(MIN_COLUMN_WIDTH)} `), ...Array.from({ length: rows }, () => empty)].join('\n');
}
