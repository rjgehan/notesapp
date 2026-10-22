// Typing shortcuts in Live Preview (DESIGN §6.6.1, ROADMAP 10a): what you type at the start of a
// line becomes the block it stands for, written as ordinary Markdown. `# ` to `###### `, `- `, `* `,
// `1. ` and `> ` already are that Markdown, and Live Preview shows them as the block as soon as
// they are typed; these rules add the rest. `[] ` (or `[ ] `, `[x] `) makes a task; Enter after
// `---` under a paragraph makes a rule rather than a heading, Enter after a code fence closes the
// block, and Enter after a `|` header line makes a table and opens its first cell. A conversion is
// an undo step of its own, so one Mod-Z gives back what was typed. (`[[` opens the note list, as in
// every mode: completion.ts.)
import { completionStatus } from '@codemirror/autocomplete';
import { isolateHistory } from '@codemirror/commands';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, Prec, Transaction, type EditorState, type Extension, type Line } from '@codemirror/state';
import { EditorView, keymap, type Command } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { tableEdit } from './table/facets';
import { gridAt } from './table/grid';
import { displayWidth, parseRow } from './table/model';

/** Blocks inside which nothing typed is converted. */
const RAW = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock', 'Frontmatter', 'Table']);

function ancestors(state: EditorState, pos: number): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) out.push(n);
  return out;
}

function inRawBlock(state: EditorState, pos: number): boolean {
  return ancestors(state, pos).some((n) => RAW.has(n.name));
}

function editable(view: EditorView): boolean {
  return !view.state.readOnly && view.state.facet(EditorView.editable);
}

// ---------- `[] ` ----------

/** Quote markers and a list marker, then `[]`, `[ ]` or `[x]`, then the space just typed. */
const TASK_SHORTCUT = /^([ \t]*(?:>[ \t]?)*[ \t]*)((?:[-+*]|\d{1,9}[.)])[ \t]+)?\[([ xX]?)\] $/;

/** `[] ` at the start of a line (or after a list marker) becomes a task, `- [ ] `. */
const taskShortcut = EditorView.inputHandler.of((view, from, to, text, insert) => {
  if (text !== ' ' || from !== to || view.composing || !editable(view)) return false;
  const line = view.state.doc.lineAt(from);
  const m = TASK_SHORTCUT.exec(line.text.slice(0, from - line.from) + ' ');
  if (!m || inRawBlock(view.state, line.from)) return false;
  // What was typed is an undo step; the conversion is the next one.
  view.dispatch(insert());
  const box = m[3] === 'x' || m[3] === 'X' ? 'x' : ' ';
  const task = m[1] + (m[2] ?? '- ') + `[${box}] `;
  view.dispatch({
    changes: { from: line.from, to: from + 1, insert: task },
    selection: EditorSelection.cursor(line.from + task.length),
    userEvent: 'input.rule',
    annotations: isolateHistory.of('full'),
    scrollIntoView: true,
  });
  return true;
});

// ---------- Enter ----------

/** `---` under a paragraph would make it a heading (setext): Enter puts a blank line between, so it is a rule. */
function ruleAfterParagraph(view: EditorView, line: Line): boolean {
  // On the first line, `---` starts properties (frontmatter), as in Obsidian.
  if (line.number === 1 || !/^ {0,3}-{3,}[ \t]*$/.test(line.text)) return false;
  if (!ancestors(view.state, line.from + line.text.indexOf('-')).some((n) => n.name === 'SetextHeading2')) return false;
  view.dispatch({
    changes: [
      { from: line.from, insert: '\n' },
      { from: line.to, insert: '\n' },
    ],
    selection: EditorSelection.cursor(line.to + 2),
    userEvent: 'input.rule',
    scrollIntoView: true,
  });
  return true;
}

/** A code fence (with an optional language), after any quote or list markup on its line. */
const FENCE_LINE = /^((?:[ \t]*>[ \t]?)*[ \t]*(?:(?:[-+*]|\d{1,9}[.)])[ \t]+)?)(`{3,}|~{3,})(.*)$/;

/**
 * Whether the block a fence opens is already closed. The fence that closes it may be one that
 * opened another block before this fence was typed: parsed without this line, such a fence opens
 * a block of its own, which is how a block's own closing fence is told apart.
 */
function fenceClosed(state: EditorState, code: SyntaxNode, line: Line, nested: boolean): boolean {
  const marks = code.getChildren('CodeMark');
  if (marks.length < 2) return false;
  // Inside a quote or a list the text after the line cannot be parsed on its own: trust the tree.
  if (nested) return true;
  const restFrom = Math.min(state.doc.length, line.to + 1);
  const at = marks[marks.length - 1].from - restFrom;
  let opens = false;
  markdownLanguage.parser.parse(state.sliceDoc(restFrom)).iterate({
    from: at,
    to: at,
    enter(node) {
      if (node.name === 'FencedCode' && node.from === at) opens = true;
      return !opens;
    },
  });
  return opens;
}

/** Enter at the end of an opening code fence closes the block, with the cursor on the line between. */
function closeFence(view: EditorView, line: Line): boolean {
  const m = FENCE_LINE.exec(line.text);
  if (!m || (m[2][0] === '`' && m[3].includes('`'))) return false;
  const fenceFrom = line.from + m[1].length;
  const code = ancestors(view.state, fenceFrom).find((n) => n.name === 'FencedCode');
  if (!code || code.from !== fenceFrom) return false;
  if (fenceClosed(view.state, code, line, /[>\-+*\d]/.test(m[1]))) return false;
  // Continuation lines of a list item are indented as far as its text, and quotes keep their `>`.
  const indent = m[1].replace(/(?:[-+*]|\d{1,9}[.)])[ \t]+$/, (marker) => ' '.repeat(marker.length));
  view.dispatch({
    changes: { from: line.to, insert: '\n' + indent + '\n' + indent + m[2] },
    selection: EditorSelection.cursor(line.to + 1 + indent.length),
    userEvent: 'input.rule',
    scrollIntoView: true,
  });
  return true;
}

/** Whether `text` reads as one table, and nothing else. */
function isTable(text: string): boolean {
  const table = markdownLanguage.parser.parse(text).topNode.firstChild;
  return table !== null && table.name === 'Table' && table.from === 0 && table.to === text.length && table.nextSibling === null;
}

/**
 * Enter after a header line (`| Name | Date |`) makes a table: the header, a delimiter row and an
 * empty row, padded, kept apart from the text around them by blank lines; the empty row's first
 * cell opens.
 */
function tableFromHeader(view: EditorView, line: Line): boolean {
  const { state } = view;
  if (!/^ {0,3}\|/.test(line.text)) return false;
  const path = ancestors(state, line.from + line.text.indexOf('|'));
  const paragraph = path.find((n) => n.name === 'Paragraph');
  if (!paragraph || paragraph.parent?.name !== 'Document' || path.some((n) => RAW.has(n.name))) return false;
  const row = parseRow(line.text);
  const pipes = (row.lead ? 1 : 0) + Math.max(0, row.cells.length - 1) + (row.trail ? 1 : 0);
  if (row.cells.length === 0 || pipes < 2) return false;
  const widths = row.cells.map((c) => Math.max(3, displayWidth(c.text)));
  const join = (cells: string[]) => `| ${cells.join(' | ')} |`;
  const header = join(row.cells.map((c, i) => c.text + ' '.repeat(widths[i] - displayWidth(c.text))));
  const delimiter = join(widths.map((w) => '-'.repeat(w)));
  const empty = join(widths.map((w) => ' '.repeat(w)));
  const table = [header, delimiter, empty].join('\n');
  if (!isTable(table)) return false;
  const previous = line.number > 1 ? state.doc.line(line.number - 1) : null;
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
  const before = previous && previous.text.trim() !== '' ? '\n' : '';
  const after = next && next.text.trim() !== '' ? '\n' : '';
  const start = line.from + before.length;
  const rowStart = start + header.length + delimiter.length + 2;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert: before + table + after },
    // Without a grid (the parse has not caught up), the caret goes into the cell.
    selection: EditorSelection.cursor(rowStart + 2),
    annotations: [tableEdit.of(0), Transaction.userEvent.of('input.table')],
    scrollIntoView: true,
  });
  gridAt(view, start)?.activate(1, 0, 'start');
  return true;
}

/** Enter at the end of a line that a typing shortcut converts. */
const enterShortcut: Command = (view) => {
  const { state } = view;
  if (!editable(view) || state.selection.ranges.length !== 1 || !state.selection.main.empty || completionStatus(state) === 'active') return false;
  const line = state.doc.lineAt(state.selection.main.head);
  if (state.selection.main.head !== line.to || line.text.trim() === '') return false;
  return ruleAfterParagraph(view, line) || closeFence(view, line) || tableFromHeader(view, line);
};

/** The typing shortcuts of an editable Live Preview note. */
export function inputRules(): Extension {
  return [taskShortcut, Prec.highest(keymap.of([{ key: 'Enter', run: enterShortcut }]))];
}
