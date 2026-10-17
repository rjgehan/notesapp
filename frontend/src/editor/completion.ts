// Completion sources (DESIGN §6.6 #8): `[[` notes and aliases, `[[Note#` / `[[#` headings, `#` tags.
// Sources rank with fuzzysort and return `filter: false` without `validFor`, so CodeMirror re-runs
// them on every keystroke and the list re-ranks as the query grows.
import { pickedCompletion, startCompletion, type Completion, type CompletionContext, type CompletionResult, type CompletionSource } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import type { FileEntry } from '../api/types';
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
  if (view.state.readOnly) return false;
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
