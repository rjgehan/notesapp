// The editor's own items of the `/` menu (DESIGN §6.6.2). Each one runs a command the editor
// already has (the line commands and toggles of formatting.ts, the table, the rule, the link
// commands) or inserts a block of Markdown. The app adds its commands (templates, attachments,
// voice notes, tasks, …) with registerSlashItem.
import { startCompletion } from '@codemirror/autocomplete';
import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { dayjs } from '../features/dates';
import { insertWikilink } from './completion';
import { noteContext } from './context';
import { insertHorizontalRule, toggleCheckbox } from './editorCommands';
import { setHeading, toggleBulletList, toggleLink, toggleNumberedList, toggleQuote } from './formatting';
import { insertTable } from './livePreview/table';
import type { SlashItem } from './slashRegistry';

/**
 * Inserts a block of Markdown on the cursor's line when it is blank, or after it, with the blank
 * lines that keep it apart from the text around it (as Insert table does), and puts the cursor at
 * `cursor` (an offset in `text`).
 */
export function insertBlock(view: EditorView, text: string, cursor: number = text.length): boolean {
  const { state } = view;
  if (state.readOnly) return false;
  const line = state.doc.lineAt(state.selection.main.head);
  const blank = line.text.trim() === '';
  const previous = line.number > 1 ? state.doc.line(line.number - 1) : null;
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
  const before = blank ? (previous && previous.text.trim() !== '' ? '\n' : '') : '\n\n';
  const after = next && next.text.trim() !== '' ? '\n' : '';
  const from = blank ? line.from : line.to;
  view.dispatch({
    changes: { from, to: line.to, insert: before + text + after },
    selection: { anchor: from + before.length + cursor },
    userEvent: 'input',
    scrollIntoView: true,
  });
  return true;
}

/** Inserts text at the cursor, putting the cursor `cursor` characters into it. */
export function insertInline(view: EditorView, text: string, cursor: number = text.length): boolean {
  if (view.state.readOnly) return false;
  const { from, to } = view.state.selection.main;
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + cursor }, userEvent: 'input', scrollIntoView: true });
  return true;
}

/** `![[]]` with the cursor inside and the file list open (Markdown links: `![]()`, as `[[` gives). */
export function insertEmbed(view: EditorView): boolean {
  if (!insertInline(view, '![[]]', 3)) return false;
  startCompletion(view);
  return true;
}

/** `[[#^]]` with the list of this note's blocks open (ROADMAP item 20). */
export function insertBlockLink(view: EditorView): boolean {
  if (!insertInline(view, '[[#^]]', 4)) return false;
  startCompletion(view);
  return true;
}

function templateFormats(state: EditorState): { date: string; time: string } {
  const t = state.facet(noteContext)?.settings().templates;
  return { date: t?.dateFormat || 'YYYY-MM-DD', time: t?.timeFormat || 'HH:mm' };
}

/** The `/` menu's dates, in the formats of Settings, Templates (as `{{date}}` and `{{time}}` write them). */
function dateText(state: EditorState, kind: 'today' | 'tomorrow' | 'yesterday' | 'time' | 'now'): string {
  const f = templateFormats(state);
  const now = dayjs();
  switch (kind) {
    case 'today':
      return now.format(f.date);
    case 'tomorrow':
      return now.add(1, 'day').format(f.date);
    case 'yesterday':
      return now.subtract(1, 'day').format(f.date);
    case 'time':
      return now.format(f.time);
    case 'now':
      return `${now.format(f.date)} ${now.format(f.time)}`;
  }
}

/** Obsidian's callout types and their aliases. */
const CALLOUTS: ReadonlyArray<[type: string, label: string, aliases: string]> = [
  ['note', 'Note', ''],
  ['info', 'Info', ''],
  ['tip', 'Tip', 'hint important'],
  ['warning', 'Warning', 'caution attention'],
  ['danger', 'Danger', 'error'],
  ['success', 'Success', 'check done'],
  ['question', 'Question', 'help faq'],
  ['todo', 'To do', 'todo'],
  ['example', 'Example', ''],
  ['quote', 'Quote', 'cite'],
  ['abstract', 'Abstract', 'summary tldr'],
  ['failure', 'Failure', 'fail missing'],
  ['bug', 'Bug', ''],
];

/** Fence languages offered by name (any other: "Code block", then type the language). */
const CODE_LANGUAGES: ReadonlyArray<[info: string, label: string, aliases: string]> = [
  ['js', 'JavaScript', 'javascript'],
  ['ts', 'TypeScript', 'typescript'],
  ['python', 'Python', 'py'],
  ['java', 'Java', ''],
  ['bash', 'Shell', 'bash sh zsh terminal console'],
  ['json', 'JSON', ''],
  ['yaml', 'YAML', 'yml'],
  ['sql', 'SQL', ''],
  ['html', 'HTML', ''],
  ['css', 'CSS', ''],
  ['go', 'Go', 'golang'],
  ['rust', 'Rust', 'rs'],
  ['csharp', 'C#', 'csharp cs dotnet'],
  ['c', 'C', ''],
  ['cpp', 'C++', 'cpp'],
  ['markdown', 'Markdown', 'md'],
];

let cached: SlashItem[] | null = null;

export function editorSlashItems(): SlashItem[] {
  if (cached) return cached;
  const items: SlashItem[] = [];
  for (let level = 1; level <= 6; level++) {
    items.push({
      id: `heading${level}`,
      label: `Heading ${level}`,
      keywords: `h${level} title heading`,
      group: 'Text',
      scope: 'block',
      order: 10 + level,
      run: (v) => setHeading(v, level),
    });
  }
  items.push(
    { id: 'text', label: 'Normal text', keywords: 'paragraph plain body', group: 'Text', scope: 'block', order: 17, run: (v) => setHeading(v, 0) },
    { id: 'bulletList', label: 'Bulleted list', keywords: 'ul unordered bullet list', group: 'List', scope: 'block', order: 20, run: (v) => toggleBulletList(v) },
    { id: 'numberedList', label: 'Numbered list', keywords: 'ol ordered numbered list', group: 'List', scope: 'block', order: 21, run: (v) => toggleNumberedList(v) },
    { id: 'checklist', label: 'Checklist', keywords: 'todo task checkbox check list', group: 'List', scope: 'block', order: 22, run: (v) => toggleCheckbox(v) },
    { id: 'quote', label: 'Quote', keywords: 'blockquote', group: 'Block', scope: 'block', order: 23, run: (v) => toggleQuote(v) },
    { id: 'callout', label: 'Callout', keywords: 'admonition note box', group: 'Block', scope: 'block', order: 24, run: (v) => insertBlock(v, '> [!note]\n> ') },
    { id: 'table', label: 'Table', keywords: 'grid columns rows', group: 'Block', scope: 'block', order: 25, run: (v) => insertTable(v) },
    { id: 'divider', label: 'Divider', keywords: 'hr horizontal rule line separator ---', group: 'Block', scope: 'block', order: 26, run: (v) => insertHorizontalRule(v) },
    { id: 'code', label: 'Code block', keywords: 'fence snippet pre ```', group: 'Block', scope: 'block', order: 27, run: (v) => insertBlock(v, '```\n```', 3) },
    { id: 'math', label: 'Math block', keywords: 'latex katex equation formula $$', group: 'Block', scope: 'block', order: 28, run: (v) => insertBlock(v, '$$\n\n$$', 3) },
    {
      id: 'mermaid',
      label: 'Mermaid diagram',
      keywords: 'diagram flowchart chart graph sequence',
      group: 'Block',
      scope: 'block',
      order: 29,
      run: (v) => insertBlock(v, '```mermaid\nflowchart TD\n    A --> B\n```', '```mermaid\nflowchart TD\n    A --> B'.length),
    },
    { id: 'inlineMath', label: 'Inline math', keywords: 'latex katex equation formula $', group: 'Inline', scope: 'inline', order: 40, run: (v) => insertInline(v, '$$', 1) },
    { id: 'link', label: 'Link', keywords: 'url web hyperlink address', group: 'Link', scope: 'inline', order: 50, run: (v) => toggleLink(v) },
    { id: 'wikilink', label: 'Internal link', keywords: 'wikilink note page [[', group: 'Link', scope: 'inline', order: 51, run: (v) => insertWikilink(v) },
    { id: 'embed', label: 'Embed', keywords: 'transclude ![[ file note image drawing spreadsheet sheet canvas pdf', group: 'Link', scope: 'inline', order: 52, run: (v) => insertEmbed(v) },
    { id: 'blockLink', label: 'Block reference', keywords: 'block link ^ [[#^ reference', group: 'Link', scope: 'inline', order: 53, run: (v) => insertBlockLink(v) },
  );
  const dates: ReadonlyArray<[kind: 'today' | 'time' | 'now' | 'tomorrow' | 'yesterday', label: string, keywords: string]> = [
    ['today', 'Today', 'date today'],
    ['time', 'Time', 'clock now'],
    ['now', 'Date and time', 'now timestamp datetime'],
    ['tomorrow', 'Tomorrow', 'date'],
    ['yesterday', 'Yesterday', 'date'],
  ];
  dates.forEach(([kind, label, keywords], i) => {
    items.push({ id: `date.${kind}`, label, keywords, group: 'Date', hint: (s) => dateText(s, kind), scope: 'inline', order: 80 + i, run: (v) => insertInline(v, dateText(v.state, kind)) });
  });
  CALLOUTS.forEach(([type, label, aliases], i) => {
    items.push({
      id: `callout.${type}`,
      label: `Callout: ${label}`,
      keywords: `callout admonition ${type} ${aliases}`,
      group: 'Callout',
      scope: 'block',
      order: 100 + i,
      run: (v) => insertBlock(v, `> [!${type}]\n> `),
    });
  });
  CODE_LANGUAGES.forEach(([info, label, aliases], i) => {
    items.push({
      id: `code.${info}`,
      label: `Code: ${label}`,
      keywords: `code block fence ${info} ${aliases}`,
      group: 'Code',
      scope: 'block',
      order: 200 + i,
      run: (v) => insertBlock(v, '```' + info + '\n\n```', info.length + 4),
    });
  });
  cached = items;
  return items;
}
