// Completion sources (DESIGN §6.6 #8): `[[` notes and aliases, `[[Note#` / `[[#` headings,
// `[[Note#^` / `[[#^` blocks (ROADMAP item 20, DESIGN §6.37), `#` tags.
// Sources rank with fuzzysort and return `filter: false` without `validFor`, so CodeMirror re-runs
// them on every keystroke and the list re-ranks as the query grows.
import { pickedCompletion, startCompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import type { FileEntry } from '../api/types';
import { blockIdsIn, newBlockId, noteLines, pickableBlocks, planBlockId, scanBlocks, type NoteBlock } from '../features/blocks';
import { fuzzyRank } from '../features/fuzzy';
import { encodeMdPath, linkText, resolve } from '../features/links';
import { displayName, folderOf, stripMd } from '../features/paths';
import { noteContext, type NoteContext } from './context';
import { inCodeOrComment, inFrontmatter } from './linkAt';
import { headingsFromState } from './outline';

const MAX_OPTIONS = 50;

interface LinkItem {
  label: string;
  path: string;
  entry: FileEntry;
  alias: string | null;
}

function linkItems(ctx: NoteContext): LinkItem[] {
  const tree = ctx.tree();
  const items: LinkItem[] = [];
  for (const entry of tree.files) {
    items.push({ label: entry.kind === 'note' ? entry.basename : entry.name, path: entry.path, entry, alias: null });
  }
  for (const { alias, entry } of tree.aliasItems) items.push({ label: alias, path: entry.path, entry, alias });
  return items;
}

function rankLinkItems(ctx: NoteContext, query: string): LinkItem[] {
  const items = linkItems(ctx);
  if (query.trim() === '') {
    const recent = ctx.recentPaths();
    const order = new Map(recent.map((p, i) => [p, i]));
    return items
      .filter((i) => i.alias === null && i.path !== ctx.path())
      .sort((a, b) => {
        const ra = order.get(a.path) ?? Infinity;
        const rb = order.get(b.path) ?? Infinity;
        if (ra !== rb) return ra - rb;
        return Date.parse(b.entry.mtime) - Date.parse(a.entry.mtime);
      })
      .slice(0, MAX_OPTIONS);
  }
  return fuzzyRank(query, items, [(i) => i.label, (i) => i.path], MAX_OPTIONS, (i) => (i.entry.kind === 'note' ? 0.05 : 0)).map(
    (r) => r.item,
  );
}

/** Replaces `[[query` (plus an auto-inserted `]]`) with `insert`, leaving the cursor after it. */
function replaceLink(view: EditorView, completion: Completion, openFrom: number, to: number, insert: string): void {
  const end = view.state.sliceDoc(to, to + 2) === ']]' ? to + 2 : to;
  view.dispatch({
    changes: { from: openFrom, to: end, insert },
    selection: { anchor: openFrom + insert.length },
    userEvent: 'input.complete',
    annotations: pickedCompletion.of(completion),
  });
}

function buildInsert(ctx: NoteContext, item: { path: string; alias: string | null }, embed: boolean, subpath: string | null, display: string | null): string {
  const s = ctx.settings().files;
  const index = ctx.tree().links;
  const source = ctx.path();
  if (s.useWikilinks) {
    const text = linkText(item.path, source, s.newLinkFormat, 'wiki', index);
    const sub = subpath ? '#' + subpath : '';
    const disp = display ? '|' + display : item.alias ? '|' + item.alias : '';
    return `${embed ? '!' : ''}[[${text}${sub}${disp}]]`;
  }
  const text = linkText(item.path, source, s.newLinkFormat, 'markdown', index);
  const sub = subpath ? '#' + encodeMdPath(subpath) : '';
  if (embed) return `![](${text}${sub})`;
  const label = display ?? item.alias ?? subpath ?? stripMd(displayName(item.path));
  return `[${label}](${text}${sub})`;
}

export const wikilinkSource: CompletionSource = (context: CompletionContext): CompletionResult | null => {
  const ctx = context.state.facet(noteContext);
  if (!ctx || inCodeOrComment(context.state, context.pos)) return null;
  const match = context.matchBefore(/!?\[\[[^[\]\n#|]*$/);
  if (!match) return null;
  const embed = match.text.startsWith('!');
  const queryFrom = match.from + (embed ? 3 : 2);
  const query = context.state.sliceDoc(queryFrom, context.pos);
  const options: Completion[] = rankLinkItems(ctx, query).map((item) => ({
    label: item.label,
    detail: item.alias ? `alias of ${displayName(item.path)}` : folderOf(item.path) || undefined,
    type: item.entry.kind === 'note' ? 'note' : 'file',
    apply: (view, completion, _from, to) => replaceLink(view, completion, match.from, to, buildInsert(ctx, item, embed, null, null)),
  }));
  return { from: queryFrom, options, filter: false };
};

export const headingSource: CompletionSource = async (context: CompletionContext): Promise<CompletionResult | null> => {
  const ctx = context.state.facet(noteContext);
  if (!ctx || inCodeOrComment(context.state, context.pos)) return null;
  const match = context.matchBefore(/!?\[\[[^[\]\n|#]*#[^[\]\n|]*$/);
  if (!match) return null;
  const embed = match.text.startsWith('!');
  const body = match.text.slice(embed ? 3 : 2);
  const hash = body.indexOf('#');
  const target = body.slice(0, hash).trim();
  const queryFrom = match.from + (embed ? 3 : 2) + hash + 1;
  const query = context.state.sliceDoc(queryFrom, context.pos).split('#').pop() ?? '';
  const source = ctx.path();
  const resolved = target === '' ? source : resolve(target, source, ctx.tree().links);
  if (resolved === null) return null;
  if (query.startsWith('^')) return blockCompletion(context, ctx, { linkFrom: match.from, embed, target, resolved, query: query.slice(1) });

  let headings: Array<{ text: string; level: number }>;
  if (resolved === source) {
    headings = headingsFromState(context.state);
  } else {
    if (!resolved.toLowerCase().endsWith('.md')) return null;
    try {
      headings = (await ctx.noteMeta(resolved)).headings;
    } catch {
      return null;
    }
    if (context.aborted) return null;
  }
  const ranked = query.trim() === '' ? headings : fuzzyRank(query, headings, [(h) => h.text], MAX_OPTIONS).map((r) => r.item);
  const options: Completion[] = ranked.slice(0, MAX_OPTIONS).map((h) => ({
    label: h.text,
    detail: `H${h.level}`,
    type: 'heading',
    apply: (view, completion, _from, to) => {
      let insert: string;
      if (target === '') {
        const s = ctx.settings().files;
        insert = s.useWikilinks ? `${embed ? '!' : ''}[[#${h.text}]]` : `[${h.text}](#${encodeMdPath(h.text)})`;
      } else {
        insert = buildInsert(ctx, { path: resolved, alias: null }, embed, h.text, null);
      }
      replaceLink(view, completion, match.from, to, insert);
    },
  }));
  return { from: queryFrom, options, filter: false };
};

const BLOCK_KIND: Record<NoteBlock['kind'], string> = {
  paragraph: 'paragraph',
  heading: 'heading',
  'list-item': 'list item',
  list: 'list',
  quote: 'quote',
  callout: 'callout',
  table: 'table',
  code: 'code',
  math: 'math',
};

interface BlockQuery {
  /** Where `[[` (or `![[`) starts. */
  linkFrom: number;
  embed: boolean;
  /** The link's target as typed (`""` for this note). */
  target: string;
  resolved: string;
  /** What follows `^`. */
  query: string;
}

/**
 * `[[Note#^query`: the target's paragraphs, headings, list items and structured blocks. Picking
 * one without an id gives it one (` ^a1b2c3`): in this note as part of the same edit, in another
 * note through `ctx.blocks` (the server adds it to the current file, so it is safe with edits
 * elsewhere). The link names the new id at once; if the server keeps another (the block got one
 * meanwhile), the link is corrected.
 */
async function blockCompletion(context: CompletionContext, ctx: NoteContext, q: BlockQuery): Promise<CompletionResult | null> {
  const source = ctx.path();
  const same = q.resolved === source;
  let text: string;
  if (same) {
    if (!source.toLowerCase().endsWith('.md')) return null;
    text = context.state.doc.toString();
  } else {
    if (!q.resolved.toLowerCase().endsWith('.md') || !ctx.blocks) return null;
    try {
      text = await ctx.blocks.noteText(q.resolved);
    } catch {
      return null;
    }
    if (context.aborted) return null;
  }
  const cursorLine = context.state.doc.lineAt(context.pos).number - 1;
  const blocks = pickableBlocks(scanBlocks(text)).filter((b) => !same || cursorLine < b.start || cursorLine > b.end);
  const ranked =
    q.query.trim() === ''
      ? blocks.slice(0, MAX_OPTIONS * 4)
      : fuzzyRank(q.query, blocks, [(b) => b.text, (b) => b.id ?? ''], MAX_OPTIONS).map((r) => r.item);
  const options: Completion[] = ranked.map((b) => ({
    label: b.text,
    detail: b.id ? `^${b.id}` : BLOCK_KIND[b.kind],
    type: 'block',
    apply: (view, completion, _from, to) => {
      const insertFor = (id: string) => (same ? sameNoteLink(ctx, q.embed, '^' + id, null) : buildInsert(ctx, { path: q.resolved, alias: null }, q.embed, '^' + id, null));
      if (b.id) return replaceLink(view, completion, q.linkFrom, to, insertFor(b.id));
      if (same) return linkToNewBlockHere(view, completion, q.linkFrom, to, b, text, insertFor);
      const provisional = newBlockId(blockIdsIn(text));
      replaceLink(view, completion, q.linkFrom, to, insertFor(provisional));
      void ctx.blocks!.ensureBlockId(q.resolved, text, b, provisional).then(
        (id) => {
          if (id !== provisional) renameInsertedId(view, q.linkFrom, provisional, id);
        },
        () => {},
      );
    },
  }));
  return { from: context.pos - q.query.length, options, filter: false };
}

/** A link to part of this note, in the note's link style. */
function sameNoteLink(ctx: NoteContext, embed: boolean, subpath: string, display: string | null): string {
  const s = ctx.settings().files;
  if (s.useWikilinks) return `${embed ? '!' : ''}[[#${subpath}${display ? '|' + display : ''}]]`;
  return `${embed ? '!' : ''}[${display ?? (embed ? '' : subpath)}](#${encodeMdPath(subpath)})`;
}

/** Adds the id to a block of this note and the link to it, as one edit (one undo step). */
function linkToNewBlockHere(view: EditorView, completion: Completion, linkFrom: number, to: number, block: NoteBlock, text: string, insertFor: (id: string) => string): void {
  const current = view.state.doc.toString();
  const lineText = noteLines(text)[block.anchor] ?? '';
  const id = newBlockId(blockIdsIn(current));
  const plan = planBlockId(current, { line: block.anchor, lineText, placement: block.placement }, id);
  if (plan.kind === 'missing') return;
  const insert = insertFor(plan.id);
  if (plan.kind === 'existing') return replaceLink(view, completion, linkFrom, to, insert);
  const end = view.state.sliceDoc(to, to + 2) === ']]' ? to + 2 : to;
  const shift = plan.from <= linkFrom ? plan.insert.length : 0;
  view.dispatch({
    changes: [
      { from: plan.from, insert: plan.insert },
      { from: linkFrom, to: end, insert },
    ],
    selection: { anchor: linkFrom + shift + insert.length },
    userEvent: 'input.complete',
    annotations: pickedCompletion.of(completion),
  });
}

/** Replaces the provisional id written into a link near `near` with the id the block got. */
function renameInsertedId(view: EditorView, near: number, provisional: string, id: string): void {
  const doc = view.state.doc.toString();
  let best = -1;
  for (let at = doc.indexOf(provisional); at >= 0; at = doc.indexOf(provisional, at + 1)) {
    if (best < 0 || Math.abs(at - near) < Math.abs(best - near)) best = at;
  }
  if (best < 0) return;
  try {
    view.dispatch({ changes: { from: best, to: best + provisional.length, insert: id }, userEvent: 'input.complete' });
  } catch {
    // The editor closed meanwhile; the note keeps the link as written.
  }
}

export const tagSource: CompletionSource = async (context: CompletionContext): Promise<CompletionResult | null> => {
  const ctx = context.state.facet(noteContext);
  if (!ctx) return null;
  const match = context.matchBefore(/(?<!\S)#[^\s!-,.:-@[-^`{-~]*$/u);
  if (!match || inCodeOrComment(context.state, context.pos) || inFrontmatter(context.state, context.pos)) return null;
  const query = match.text.slice(1);
  const local = new Set<string>();
  syntaxTree(context.state).iterate({
    enter(node) {
      if (node.name === 'Hashtag' && (node.to < match.from || node.from > context.pos)) local.add(context.state.sliceDoc(node.from + 1, node.to));
    },
  });
  let vault: string[] = [];
  try {
    vault = await ctx.vaultTags();
  } catch {
    // Offline: local tags still complete.
  }
  if (context.aborted) return null;
  const seen = new Set<string>();
  const all: string[] = [];
  for (const tag of [...vault, ...local]) {
    const key = tag.toLowerCase();
    if (!seen.has(key) && key !== query.toLowerCase()) {
      seen.add(key);
      all.push(tag);
    }
  }
  const ranked = query === '' ? all.sort((a, b) => a.localeCompare(b)).slice(0, MAX_OPTIONS) : fuzzyRank(query, all, [(t) => t], MAX_OPTIONS).map((r) => r.item);
  if (ranked.length === 0) return null;
  return {
    from: match.from + 1,
    options: ranked.map((tag) => ({
      label: tag,
      type: 'tag',
      apply: (view, completion, from, to) => {
        view.dispatch({
          changes: { from, to, insert: tag + ' ' },
          selection: { anchor: from + tag.length + 1 },
          userEvent: 'input.complete',
          annotations: pickedCompletion.of(completion),
        });
      },
    })),
    filter: false,
  };
};

/** Inserts `[[]]` with the cursor inside and opens the note list (palette command and toolbar). */
export function insertWikilink(view: EditorView): boolean {
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  view.dispatch({
    changes: { from, to, insert: `[[${selected}]]` },
    selection: { anchor: from + 2 + selected.length },
    userEvent: 'input',
  });
  startCompletion(view);
  return true;
}
