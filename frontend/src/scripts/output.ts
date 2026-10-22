// Scripts in notes (ROADMAP item 40, DESIGN §6.39): what a script showed, as Markdown for the app's
// reading pipeline (markdown-it, DOMPurify, the embeds), which renders it like any block of a note.
// Text is escaped, so only what a script passes as Markdown (`show("**x**")`) is read as Markdown;
// links and embeds become wikilinks, which resolve inside the vault and nowhere else.
import type { OutputItem } from './protocol';

/** Every ASCII punctuation character can be backslash-escaped in CommonMark. */
export function escapeText(s: string): string {
  return s.replace(/[\\`*_{}[\]<>()#+\-.!|~=$%^&:"']/g, '\\$&');
}

const oneLine = (s: string) => s.replace(/\r?\n/g, ' ');

/** A wikilink's target and display text may not hold `[`, `]`, `|` or a line break. */
function wikiSafe(s: string): string {
  return oneLine(s).replace(/[[\]|]/g, ' ').trim();
}

function link(path: string, title: string, inTable: boolean): string {
  const target = wikiSafe(path);
  const display = wikiSafe(title) || target;
  if (!target || /[#^]/.test(target)) return escapeText(display);
  return `[[${target}${inTable ? '\\|' : '|'}${display}]]`;
}

/** An item inside a line (a list entry, a table cell). */
function inline(item: OutputItem, inTable: boolean): string {
  switch (item.t) {
    case 'md':
      return oneLine(item.v).replace(/\|/g, inTable ? '\\|' : '|');
    case 'text':
      return escapeText(oneLine(item.v));
    case 'code': {
      const v = oneLine(item.v);
      const ticks = '`'.repeat(Math.max(1, ...(v.match(/`+/g) ?? []).map((m) => m.length + 1)));
      return `${ticks} ${inTable ? v.replace(/\|/g, '\\|') : v} ${ticks}`;
    }
    case 'link':
      return link(item.path, item.title, inTable);
    case 'embed': {
      const target = wikiSafe(item.target);
      return target ? `![[${target}]]` : '';
    }
    case 'inline':
      return item.items.map((i) => inline(i, inTable)).join(' — ');
    case 'list':
      return item.items.map((i) => inline(i, inTable)).join(', ');
    case 'table':
      return escapeText(`(a table of ${item.rows.length} rows)`);
  }
}

function listBlock(item: Extract<OutputItem, { t: 'list' }>, depth: number): string {
  if (item.items.length === 0) return '';
  const indent = '    '.repeat(depth);
  return item.items
    .map((i) => {
      if (i.t === 'list') {
        const nested = listBlock(i, depth + 1);
        return nested ? nested : `${indent}- `;
      }
      return `${indent}- ${inline(i, false)}`;
    })
    .join('\n');
}

function tableBlock(item: Extract<OutputItem, { t: 'table' }>): string {
  const columns = item.columns.length ? item.columns : item.rows[0]?.map((_, i) => `Column ${i + 1}`) ?? [];
  if (columns.length === 0) return '';
  const row = (cells: string[]) => `| ${cells.map((c) => c || ' ').join(' | ')} |`;
  const lines = [row(columns.map((c) => escapeText(oneLine(c)))), row(columns.map(() => '---'))];
  for (const r of item.rows) lines.push(row(columns.map((_, i) => (r[i] ? inline(r[i], true) : ''))));
  return lines.join('\n');
}

function block(item: OutputItem): string {
  switch (item.t) {
    case 'md':
      return item.v;
    case 'text':
      return item.v
        .split(/\r?\n/)
        .map((l) => escapeText(l))
        .join('  \n');
    case 'code': {
      const fence = '`'.repeat(Math.max(3, ...(item.v.match(/`{3,}/g) ?? []).map((m) => m.length + 1)));
      return `${fence}\n${item.v}\n${fence}`;
    }
    case 'list':
      return listBlock(item, 0);
    case 'table':
      return tableBlock(item);
    default:
      return inline(item, false);
  }
}

/** What a script showed, as one Markdown document: its items in order, as separate blocks. */
export function outputMarkdown(items: readonly OutputItem[]): string {
  return items
    .map(block)
    .filter((b) => b.trim() !== '')
    .join('\n\n');
}
