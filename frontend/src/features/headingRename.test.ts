import { markdown } from '@codemirror/lang-markdown';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/endpoints';
import type { HeadingRenameResult } from '../api/types';
import type { OutlineHeading } from '../editor/outline';
import { useDialogs } from '../state/dialogs';
import { useToasts } from '../state/toasts';
import { describeUpdates, detectHeadingRename, headingAtCursor, previewHeadingRename, promptRenameHeading, replaceHeadingText, updateHeadingLinks } from './headingRename';

const h = (text: string, level: OutlineHeading['level'] = 2, line = 0): OutlineHeading => ({ text, level, line, from: 0 });

const result = (over: Partial<HeadingRenameResult> = {}): HeadingRenameResult => ({
  dryRun: false,
  path: 'Plan.md',
  from: 'Old',
  to: 'New',
  linkUpdates: [{ path: 'Notes.md', links: 2, version: 'v2' }],
  failed: [],
  bookmarks: 0,
  commitId: 'c1',
  ...over,
});

const views: EditorView[] = [];
function editor(doc: string, cursor: number) {
  const view = new EditorView({ state: EditorState.create({ doc, selection: EditorSelection.cursor(cursor), extensions: [markdown()] }), parent: document.body });
  views.push(view);
  return view;
}

beforeEach(() => {
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  for (const v of views.splice(0)) v.destroy();
  vi.restoreAllMocks();
});

describe('detectHeadingRename', () => {
  it('finds the one heading whose text changed', () => {
    expect(detectHeadingRename([h('Plan', 1), h('Goals'), h('Next')], [h('Plan', 1), h('Aims'), h('Next')])).toEqual({ index: 1, from: 'Goals', to: 'Aims' });
  });

  it('ignores case and spacing, and anything that is not a single rename', () => {
    expect(detectHeadingRename([h('Next  steps')], [h('next Steps')])).toBeNull();
    expect(detectHeadingRename([h('A'), h('B')], [h('A2'), h('B2')])).toBeNull();
    expect(detectHeadingRename([h('A')], [h('A'), h('B')])).toBeNull();
    expect(detectHeadingRename([h('A', 2)], [h('B', 3)])).toBeNull();
    expect(detectHeadingRename([h('A')], [h('')])).toBeNull();
    expect(detectHeadingRename([h('A')], [h('A')])).toBeNull();
  });
});

describe('describeUpdates', () => {
  it('counts links, notes and bookmarks', () => {
    expect(describeUpdates(result())).toBe('2 links in 1 note');
    expect(describeUpdates(result({ linkUpdates: [{ path: 'a.md', links: 1, version: null }, { path: 'b.md', links: 1, version: null }], bookmarks: 1 }))).toBe('2 links in 2 notes and 1 bookmark');
    expect(describeUpdates(result({ linkUpdates: [], bookmarks: 2 }))).toBe('2 bookmarks');
  });
});

describe('updating heading links', () => {
  it('saves the note first, then updates the links and applies the result', async () => {
    const order: string[] = [];
    vi.spyOn(api, 'renameHeading').mockImplementation(async (req) => {
      order.push(`api:${req.dryRun ? 'dry' : 'run'}`);
      return result();
    });
    const deps = { flush: vi.fn(async () => void order.push('flush')), apply: vi.fn(() => void order.push('apply')) };
    await updateHeadingLinks('Plan.md', 'Old', 'New', deps);
    expect(order).toEqual(['flush', 'api:run', 'apply']);
    expect(api.renameHeading).toHaveBeenCalledWith({ path: 'Plan.md', from: 'Old', to: 'New' });
    expect(useToasts.getState().toasts.at(-1)?.message).toBe('Updated 2 links in 1 note to “New”');
  });

  it('previews with a dry run and gives nothing when no link points at the heading', async () => {
    const spy = vi.spyOn(api, 'renameHeading').mockResolvedValueOnce(result({ dryRun: true, linkUpdates: [], bookmarks: 0, commitId: null }));
    expect(await previewHeadingRename('Plan.md', 'Old', 'New', { flush: async () => {} })).toBeNull();
    expect(spy).toHaveBeenCalledWith({ path: 'Plan.md', from: 'Old', to: 'New', dryRun: true });
    spy.mockResolvedValueOnce(result({ dryRun: true }));
    expect(await previewHeadingRename('Plan.md', 'Old', 'New', { flush: async () => {} })).toMatchObject({ linkUpdates: [{ links: 2 }] });
    spy.mockRejectedValueOnce(new Error('still has the old heading'));
    expect(await previewHeadingRename('Plan.md', 'Old', 'New', { flush: async () => {} })).toBeNull();
  });
});

describe('editing a heading', () => {
  it('finds the heading at or above the cursor and replaces its text, keeping the marks', () => {
    const view = editor('# Plan\n\n## Old goals ##\n\nbody\n', 30);
    const heading = headingAtCursor(view)!;
    expect(heading.text).toBe('Old goals');
    expect(replaceHeadingText(view, heading, 'New goals')).toBe(true);
    expect(view.state.doc.toString()).toBe('# Plan\n\n## New goals ##\n\nbody\n');
  });

  it('replaces a setext heading’s line', () => {
    const view = editor('Old\n===\n', 0);
    expect(replaceHeadingText(view, headingAtCursor(view)!, 'New')).toBe(true);
    expect(view.state.doc.toString()).toBe('New\n===\n');
  });

  it('“Rename heading…” asks for the text, edits the heading and updates its links', async () => {
    vi.spyOn(api, 'renameHeading').mockResolvedValue(result({ from: 'Old', to: 'Newer' }));
    const view = editor('## Old\n', 3);
    const done = promptRenameHeading(view, 'Plan.md');
    const dialog = useDialogs.getState().stack.at(-1)!;
    expect(dialog.kind).toBe('prompt');
    if (dialog.kind === 'prompt') dialog.resolve('Newer');
    await done;
    expect(view.state.doc.toString()).toBe('## Newer\n');
    expect(api.renameHeading).toHaveBeenCalledWith({ path: 'Plan.md', from: 'Old', to: 'Newer' });
  });
});
