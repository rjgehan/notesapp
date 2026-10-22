import { CompletionContext, insertBracket, type Completion, type CompletionResult } from '@codemirror/autocomplete';
import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import type { FileEntry, Settings } from '../api/types';
import { buildVaultTree } from '../api/vaultTree';
import { basenameOf, extensionOf, lastSegment } from '../features/paths';
import { DEFAULT_SETTINGS } from '../features/settings';
import { headingSource, tagSource, wikilinkSource } from './completion';
import { noteContext, type NoteContext } from './context';
import { noteExtensions } from './editorSetup';
import { cellLanguage } from './livePreview/table';
import { tableCellHost } from './livePreview/table/facets';

function entry(path: string, aliases: string[] = [], mtime = '2026-10-16T10:00:00.000Z'): FileEntry {
  const ext = extensionOf(path);
  return { path, name: lastSegment(path), basename: basenameOf(path), extension: ext, kind: ext === 'md' ? 'note' : 'image', size: 1, mtime, version: ext === 'md' ? 'v' : null, aliases };
}

const tree = buildVaultTree({
  eventId: 'b.1',
  folders: [],
  files: [
    entry('Welcome.md'),
    entry('Plan.md'),
    entry('Projects/Plan.md', ['Roadmap']),
    entry('Planning poker.md'),
    entry('Ideas/Plan B.md'),
    entry('Attachments/pic.png'),
  ],
});

function context(settings: Settings = DEFAULT_SETTINGS, path = 'Welcome.md'): NoteContext {
  return {
    path: () => path,
    tree: () => tree,
    settings: () => settings,
    openLink: () => {},
    openTag: () => {},
    noteMeta: async (p) => ({
      path: p,
      version: 'v',
      frontmatter: null,
      frontmatterError: null,
      aliases: [],
      tags: [],
      headings: [
        { level: 1, text: 'Plan', line: 0 },
        { level: 2, text: 'Milestones', line: 2 },
      ],
      blockIds: [],
      links: [],
    }),
    vaultTags: async () => ['project', 'project/alpha', 'work'],
    recentPaths: () => [],
    save: () => {},
    insertFiles: () => {},
    linkTo: (path) => `[[${path}]]`,
    showMenu: () => {},
    renderEmbed: () => () => {},
    renderProperties: () => () => {},
  };
}

const hooks = { onLocalChange: () => {}, onBlur: () => {}, readOnly: false, spellcheck: false, autocorrect: false };

let views: EditorView[] = [];
afterEach(() => {
  views.forEach((v) => v.destroy());
  views = [];
});

function makeView(doc: string, cursor: number, ctx = context()): EditorView {
  const state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor), extensions: noteExtensions(ctx, hooks) });
  ensureSyntaxTree(state, state.doc.length, 5000);
  const view = new EditorView({ state: state.update({}).state });
  views.push(view);
  return view;
}

async function complete(source: typeof wikilinkSource, view: EditorView): Promise<CompletionResult | null> {
  return (await source(new CompletionContext(view.state, view.state.selection.main.head, false))) as CompletionResult | null;
}

function pick(view: EditorView, result: CompletionResult, label: string): void {
  const option = result.options.find((o) => o.label === label) as Completion;
  expect(option, `option ${label}`).toBeDefined();
  const apply = option.apply as (v: EditorView, c: Completion, from: number, to: number) => void;
  apply(view, option, result.from, view.state.selection.main.head);
}

describe('[[ completion', () => {
  it('ranks notes and aliases and re-ranks as the query grows', async () => {
    const view = makeView('[[Pla]]', 5);
    const first = await complete(wikilinkSource, view);
    expect(first?.filter).toBe(false);
    expect(first?.validFor).toBeUndefined();
    expect(first?.options.map((o) => o.label)).toContain('Planning poker');

    view.dispatch({ changes: { from: 5, insert: 'n B' }, selection: { anchor: 8 } });
    const second = await complete(wikilinkSource, view);
    expect(second?.options[0].label).toBe('Plan B');
  });

  it('offers aliases', async () => {
    const view = makeView('[[Road]]', 6);
    const result = (await complete(wikilinkSource, view))!;
    expect(result.options[0]).toMatchObject({ label: 'Roadmap', detail: 'alias of Plan' });
    pick(view, result, 'Roadmap');
    expect(view.state.doc.toString()).toBe('[[Projects/Plan|Roadmap]]');
  });

  it('swallows the ]] inserted by closeBrackets and leaves the cursor after the link', async () => {
    const view = makeView('see  x', 4);
    for (const ch of ['[', '[']) view.dispatch(insertBracket(view.state, ch)!);
    expect(view.state.doc.toString()).toBe('see [[]] x');
    view.dispatch(view.state.replaceSelection('Plan B'));
    const result = (await complete(wikilinkSource, view))!;
    pick(view, result, 'Plan B');
    expect(view.state.doc.toString()).toBe('see [[Plan B]] x');
    expect(view.state.selection.main.head).toBe('see [[Plan B]]'.length);
  });

  it('inserts a path-qualified link for one of two same-named notes', async () => {
    const view = makeView('[[Plan', 6);
    const result = (await complete(wikilinkSource, view))!;
    const plans = result.options.filter((o) => o.label === 'Plan');
    expect(plans.map((o) => o.detail)).toEqual(expect.arrayContaining([undefined, 'Projects']));
    const nested = plans.find((o) => o.detail === 'Projects') as Completion;
    (nested.apply as (v: EditorView, c: Completion, f: number, t: number) => void)(view, nested, result.from, 6);
    expect(view.state.doc.toString()).toBe('[[Projects/Plan]]');
  });

  it('inserts a Markdown link when useWikilinks is off', async () => {
    const settings = { ...DEFAULT_SETTINGS, files: { ...DEFAULT_SETTINGS.files, useWikilinks: false } };
    const view = makeView('[[Plan B]]', 8, context(settings));
    const result = (await complete(wikilinkSource, view))!;
    pick(view, result, 'Plan B');
    expect(view.state.doc.toString()).toBe('[Plan B](Plan%20B.md)');
  });

  it('keeps the ! of embeds', async () => {
    const view = makeView('![[pic', 6);
    const result = (await complete(wikilinkSource, view))!;
    pick(view, result, 'pic.png');
    expect(view.state.doc.toString()).toBe('![[pic.png]]');
  });

  it('does not complete inside code', async () => {
    expect(await complete(wikilinkSource, makeView('`[[Pla`', 6))).toBeNull();
    expect(await complete(wikilinkSource, makeView('```\n[[Pla\n```', 9))).toBeNull();
  });
});

describe('heading completion', () => {
  it('[[# lists the open note headings from the live tree', async () => {
    const doc = '# Title\n\n## Second part\n\n[[#';
    const view = makeView(doc, doc.length);
    const result = (await complete(headingSource, view))!;
    expect(result.options.map((o) => o.label)).toEqual(['Title', 'Second part']);
    pick(view, result, 'Second part');
    expect(view.state.doc.toString()).toBe('# Title\n\n## Second part\n\n[[#Second part]]');
  });

  it('[[# in a table cell lists the note’s headings', async () => {
    const note = makeView('# Title\n\n## Second part\n\n| a |\n|---|\n| b |', 0);
    const cell = EditorState.create({ doc: '[[#Sec', selection: EditorSelection.cursor(6), extensions: [noteContext.of(context()), tableCellHost.of(note), cellLanguage] });
    const result = (await headingSource(new CompletionContext(cell, 6, false))) as CompletionResult;
    expect(result.options.map((o) => o.label)).toEqual(['Second part']);
  });

  it('[[Other# uses the note metadata', async () => {
    const view = makeView('[[Projects/Plan#Mile', 20);
    const result = (await complete(headingSource, view))!;
    expect(result.options[0].label).toBe('Milestones');
    pick(view, result, 'Milestones');
    expect(view.state.doc.toString()).toBe('[[Projects/Plan#Milestones]]');
  });
});

describe('block completion (item 20)', () => {
  const PLAN = '# Plan\n\nAlpha idea ^alpha\n\nBeta idea\n\n| a |\n|---|\n';

  function blockContext(): { ctx: NoteContext; calls: Array<{ path: string; anchor: number; wanted: string }>; answer: { id: string | null } } {
    const calls: Array<{ path: string; anchor: number; wanted: string }> = [];
    const answer: { id: string | null } = { id: null };
    const ctx: NoteContext = {
      ...context(),
      blocks: {
        noteText: async () => PLAN,
        ensureBlockId: async (path, _text, block, wanted) => {
          calls.push({ path, anchor: block.anchor, wanted });
          return answer.id ?? wanted;
        },
      },
    };
    return { ctx, calls, answer };
  }

  it('[[Note#^ lists the blocks of another note and links to an existing id', async () => {
    const { ctx, calls } = blockContext();
    const view = makeView('[[Projects/Plan#^', 17, ctx);
    const result = (await complete(headingSource, view))!;
    expect(result.options.map((o) => o.label)).toEqual(['Plan', 'Alpha idea', 'Beta idea', 'a']);
    expect(result.options[1].detail).toBe('^alpha');
    pick(view, result, 'Alpha idea');
    expect(view.state.doc.toString()).toBe('[[Projects/Plan#^alpha]]');
    expect(calls).toEqual([]);
  });

  it('gives a block of another note a new id through the server, correcting the link when it differs', async () => {
    const { ctx, calls, answer } = blockContext();
    answer.id = 'given1';
    const view = makeView('![[Projects/Plan#^bet', 21, ctx);
    const result = (await complete(headingSource, view))!;
    expect(result.options[0].label).toBe('Beta idea');
    pick(view, result, 'Beta idea');
    const provisional = calls[0].wanted;
    expect(calls[0]).toMatchObject({ path: 'Projects/Plan.md', anchor: 4 });
    expect(view.state.doc.toString()).toBe(`![[Projects/Plan#^${provisional}]]`);
    await new Promise((r) => setTimeout(r, 0));
    expect(view.state.doc.toString()).toBe('![[Projects/Plan#^given1]]');
  });

  it('[[#^ adds the id to a block of this note in the same edit', async () => {
    const doc = 'First thought\n\n| a |\n|---|\n\nSee [[#^';
    const view = makeView(doc, doc.length);
    const result = (await complete(headingSource, view))!;
    expect(result.options.map((o) => o.label)).toEqual(['First thought', 'a']);
    pick(view, result, 'a');
    const text = view.state.doc.toString();
    const id = /\^([a-z0-9]{6})\n/.exec(text)![1];
    expect(text).toBe(`First thought\n\n| a |\n|---|\n\n^${id}\n\nSee [[#^${id}]]`);
    expect(view.state.selection.main.head).toBe(text.length);
  });
});

describe('tag completion', () => {
  it('completes vault and local tags after #', async () => {
    const view = makeView('#local here\n\nnew #pro', 21);
    const result = (await complete(tagSource, view))!;
    expect(result.options.map((o) => o.label)).toEqual(expect.arrayContaining(['project', 'project/alpha']));
    pick(view, result, 'project/alpha');
    expect(view.state.doc.toString()).toBe('#local here\n\nnew #project/alpha ');
  });

  it('does not complete a tag after a word character', async () => {
    expect(await complete(tagSource, makeView('a#pro', 5))).toBeNull();
  });
});
