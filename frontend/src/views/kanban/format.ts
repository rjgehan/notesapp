// The Obsidian Kanban plugin's Markdown board format (ROADMAP item 15, DESIGN §6.8.4), read and
// written as the plugin does (obsidian-kanban, src/parsers/formats/list.ts and common.ts):
//
//   ---
//
//   kanban-plugin: basic
//
//   ---
//
//   ## To do
//
//   - [ ] A card
//       with a second line
//
//
//   ## Done
//
//   **Complete**
//   - [x] Finished
//
//
//   ***
//
//   ## Archive
//
//   - [x] Old card
//
//   %% kanban:settings
//   ```
//   {"kanban-plugin":"basic"}
//   ```
//   %%
//
// Every heading is a lane (`## Title (5)` has a limit of five cards), `**Complete**` under it
// marks the cards moved there as done, and a heading "Archive" after a thematic break holds the
// archived cards. Pure and LF-only (the document session handles CRLF). What comes before the
// first lane (the frontmatter) and the settings block are kept verbatim; the rest is written in
// the plugin's own layout, so a board the plugin wrote comes back byte for byte. Lines the plugin
// would drop (a paragraph between cards) are reported in `problems`, and the view then shows the
// board without editing it.

export interface KanbanCard {
  /** The card's Markdown, continuation lines dedented (the plugin's `titleRaw`). */
  text: string;
  /** The checkbox character: ' ' open, 'x' done (any other character is kept). */
  check: string;
}

export interface KanbanLane {
  /** The heading's text without the card limit (may hold `<br>`, as the plugin writes newlines). */
  title: string;
  /** The card limit from `## Title (N)`; 0 for none. */
  maxItems: number;
  /** `**Complete**`: cards moved here are checked, and unchecked when they move out. */
  complete: boolean;
  cards: KanbanCard[];
}

export interface KanbanBoard {
  /** Everything before the first lane (the frontmatter), verbatim but for its trailing blank lines. */
  head: string;
  lanes: KanbanLane[];
  archive: KanbanCard[];
  /** From `%% kanban:settings` to the end, verbatim; '' when the file has none. */
  settingsBlock: string;
  /** The settings block's JSON ({} when there is none or it does not parse). */
  settings: Record<string, unknown>;
  /** 1-based lines the board cannot show; writing would drop them, so the view is read-only. */
  problems: number[];
}

export const COMPLETE_MARKER = '**Complete**';
export const ARCHIVE_TITLE = 'Archive';
const SETTINGS_MARKER = '%% kanban:settings';

import { FRONTMATTER } from './detect';

export { isKanbanText } from './detect';
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ITEM = /^[-*+][ \t]+(?:\[(.)\](?:[ \t]+|$))?(.*)$/;
const EMPTY_ITEM = /^[-*+][ \t]*$/;
const MAX_ITEMS = /^(.*?)\s*\((\d+)\)$/;

/** The plugin's `parseLaneTitle`: `Doing (3)` is "Doing" with a limit of three cards. */
export function parseLaneTitle(raw: string): { title: string; maxItems: number } {
  const text = raw.replace(/<br>/g, '\n').trim();
  const m = MAX_ITEMS.exec(text);
  const title = m ? m[1] : text;
  return { title: title.replace(/\n/g, '<br>'), maxItems: m ? Number(m[2]) : 0 };
}

/** The plugin's `laneTitleWithMaxItems` with `replaceNewLines`. */
export function laneHeading(lane: Pick<KanbanLane, 'title' | 'maxItems'>): string {
  const title = lane.title.trim().replace(/\r?\n/g, '<br>');
  return `## ${lane.maxItems ? `${title} (${lane.maxItems})` : title}`;
}

/** A lane title as text (the plugin writes line breaks in titles as `<br>`). */
export function laneTitleText(title: string): string {
  return title.replace(/<br>/g, ' ');
}

function settingsOf(block: string): Record<string, unknown> {
  const m = /```[^\n]*\n([\s\S]*?)\n```/.exec(block);
  if (!m) return {};
  try {
    const parsed: unknown = JSON.parse(m[1]);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The plugin's `dedentNewLines`: one level of indentation (four spaces or a tab) comes off. */
function dedent(lines: string[]): string {
  return lines
    .join('\n')
    .trim()
    .replace(/\n(?: {4}|\t)/g, '\n');
}

export function parseBoard(text: string): KanbanBoard {
  const fm = FRONTMATTER.exec(text);
  const bodyStart = fm ? fm[0].length : 0;
  // The settings block: the last line starting with the marker, to the end of the file.
  let settingsStart = -1;
  const markerRe = /^%% kanban:settings/gm;
  for (let m = markerRe.exec(text); m; m = markerRe.exec(text)) if (m.index >= bodyStart) settingsStart = m.index;
  const settingsBlock = settingsStart >= 0 ? text.slice(settingsStart) : '';
  const bodyEnd = settingsStart >= 0 ? settingsStart : text.length;
  const lines = text.slice(bodyStart, bodyEnd).split('\n');
  // Lines before the body: the board's lines are numbered from there (1-based).
  const firstLine = (text.slice(0, bodyStart).match(/\n/g) ?? []).length;

  const headings: number[] = [];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (f) fence = fence === null ? f[1][0] : line.trimStart().startsWith(fence) ? null : fence;
    else if (fence === null && HEADING.test(line)) headings.push(i);
  });

  const problems: number[] = [];
  const firstHeading = headings.length ? headings[0] : lines.length;
  const prelude = lines.slice(0, firstHeading).join('\n');
  // The frontmatter's own line ending, then the prelude (text before the first lane, kept as is).
  let head = text.slice(0, bodyStart) + prelude;
  head = head.replace(/\s+$/, '');
  if (head !== '') head += '\n\n';

  const lanes: KanbanLane[] = [];
  let archive: KanbanCard[] | null = null;
  headings.forEach((h, n) => {
    const end = n + 1 < headings.length ? headings[n + 1] : lines.length;
    const body = lines.slice(h + 1, end);
    // A thematic break right before the "Archive" heading belongs to the archive, not the lane above.
    const next = n + 1 < headings.length ? headings[n + 1] : -1;
    let breakAt = -1;
    if (next >= 0 && HEADING.exec(lines[next])![2].trim() === ARCHIVE_TITLE) {
      for (let k = body.length - 1; k >= 0; k--) {
        if (body[k].trim() === '') continue;
        if (THEMATIC_BREAK.test(body[k])) breakAt = k;
        break;
      }
    }
    const raw = HEADING.exec(lines[h])![2];
    const isArchive = archive === null && raw.trim() === ARCHIVE_TITLE && n > 0 && endsWithBreak(lines, headings[n - 1], h);
    const { cards, complete } = parseCards(breakAt >= 0 ? body.slice(0, breakAt) : body, firstLine + h + 1, problems, !isArchive);
    if (isArchive) archive = cards;
    else lanes.push({ ...parseLaneTitle(raw), complete, cards });
  });

  return { head, lanes, archive: archive ?? [], settingsBlock, settings: settingsOf(settingsBlock), problems };
}

function endsWithBreak(lines: string[], from: number, to: number): boolean {
  for (let k = to - 1; k > from; k--) {
    if (lines[k].trim() === '') continue;
    return THEMATIC_BREAK.test(lines[k]);
  }
  return false;
}

/** The cards under a heading; `lineBase` is the 1-based file line of the body's first line. */
function parseCards(body: string[], lineBase: number, problems: number[], allowComplete: boolean): { cards: KanbanCard[]; complete: boolean } {
  const cards: KanbanCard[] = [];
  let complete = false;
  let current: { check: string; lines: string[] } | null = null;
  let blanks: string[] = [];
  const close = () => {
    if (current) cards.push({ check: current.check, text: dedent(current.lines) });
    current = null;
  };
  body.forEach((line, i) => {
    if (line.trim() === '') {
      if (current) blanks.push('');
      return;
    }
    const indented = /^(?: {2,}|\t)/.test(line);
    if (current && indented) {
      current.lines.push(...blanks, line);
      blanks = [];
      return;
    }
    blanks = [];
    const item = THEMATIC_BREAK.test(line) ? null : ITEM.exec(line) ?? (EMPTY_ITEM.test(line) ? ['', undefined, ''] : null);
    if (item) {
      close();
      // `- [ ]` alone is an empty card, as the plugin reads it.
      current = { check: item[1] ?? ' ', lines: [item[2] ?? ''] };
      return;
    }
    close();
    if (allowComplete && line.trim() === COMPLETE_MARKER && cards.length === 0) complete = true;
    else problems.push(lineBase + i + 1);
  });
  close();
  return { cards, complete };
}

/** The plugin's `itemToMd`, with `indentNewLines` (four spaces). */
export function cardToMd(card: KanbanCard): string {
  return `- [${card.check}] ${card.text.trim().replace(/\r?\n/g, '\n    ')}`;
}

function laneToMd(lane: KanbanLane): string {
  const lines = [laneHeading(lane), ''];
  if (lane.complete) lines.push(COMPLETE_MARKER);
  for (const card of lane.cards) lines.push(cardToMd(card));
  lines.push('', '', '');
  return lines.join('\n');
}

function archiveToMd(archive: readonly KanbanCard[]): string {
  if (archive.length === 0) return '';
  return ['***', '', `## ${ARCHIVE_TITLE}`, '', ...archive.map(cardToMd)].join('\n');
}

/** The plugin's `boardToMd`, with this file's own frontmatter and settings block. */
export function serializeBoard(board: KanbanBoard): string {
  const body = board.lanes.map(laneToMd).join('') + archiveToMd(board.archive);
  if (board.settingsBlock === '') return (board.head + body).replace(/\n*$/, '\n');
  return board.head + body + '\n\n' + board.settingsBlock;
}

/** A new board: the plugin's frontmatter and settings block, with three lanes. */
export function newBoardText(lanes: readonly string[] = ['To do', 'Doing', 'Done']): string {
  return serializeBoard({
    head: '---\n\nkanban-plugin: basic\n\n---\n\n',
    lanes: lanes.map((title, i) => ({ title, maxItems: 0, complete: i === lanes.length - 1 && lanes.length > 1, cards: [] })),
    archive: [],
    settingsBlock: `${SETTINGS_MARKER}\n\`\`\`\n{"kanban-plugin":"basic"}\n\`\`\`\n%%`,
    settings: { 'kanban-plugin': 'basic' },
    problems: [],
  });
}

// ---------- card metadata (display) ----------

export interface CardMeta {
  /** The card's Markdown without the date, time and block id. */
  body: string;
  date: string | null;
  time: string | null;
  blockId: string | null;
}

/**
 * The plugin's card metadata: `@{2026-10-21}` a date, `@@{14:30}` a time (both with the default
 * triggers; `@[[2026-10-21]]` stays a link to the daily note), and ` ^id` a block id.
 */
export function cardMeta(text: string, settings: Record<string, unknown> = {}): CardMeta {
  const dateTrigger = typeof settings['date-trigger'] === 'string' && settings['date-trigger'] ? settings['date-trigger'] : '@';
  const timeTrigger = typeof settings['time-trigger'] === 'string' && settings['time-trigger'] ? settings['time-trigger'] : '@@';
  let body = text;
  let blockId: string | null = null;
  const nl = body.indexOf('\n');
  const first = nl < 0 ? body : body.slice(0, nl);
  const b = /\s+\^([a-zA-Z0-9-]+)$/.exec(first);
  if (b) {
    blockId = b[1];
    body = first.slice(0, b.index) + (nl < 0 ? '' : body.slice(nl));
  }
  let time: string | null = null;
  let date: string | null = null;
  body = body.replace(new RegExp(`(^|\\s)${escapeRe(timeTrigger)}\\{([^}\\n]+)\\}`), (_, pre: string, t: string) => ((time = t.trim()), pre));
  body = body.replace(new RegExp(`(^|\\s)${escapeRe(dateTrigger)}\\{([^}\\n]+)\\}`), (_, pre: string, d: string) => ((date = d.trim()), pre));
  // The removed tokens leave runs of spaces inside lines (indentation is left alone).
  return { body: body.replace(/(\S)[ \t]{2,}(?=\S)/g, '$1 ').replace(/[ \t]+$/gm, '').trim(), date, time, blockId };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
