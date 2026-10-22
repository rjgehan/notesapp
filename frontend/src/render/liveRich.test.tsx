// Locked Live Preview is the reading view (ROADMAP 10b): what the reading view rendered through
// markdown-it and the rich pack (callouts, math, Mermaid) and through the views' embeds (a
// spreadsheet) renders in the note's editor, locked or not.
import { waitFor } from '@testing-library/react';
import { Sheet } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../api/queryClient';
import { queryKeys } from '../api/queryKeys';
import type { FileEntry } from '../api/types';
import { buildVaultTree } from '../api/vaultTree';
import { renderedRichBlocks } from '../editor/livePreview/rich';
import { destroyEditors, noteEditor, testContext } from '../test/noteEditor';
import { registerView, type EmbedProps } from '../views/registry';
import { renderLiveEmbed } from './liveEmbeds';
import { renderLiveMarkdown, renderLiveMath } from './liveRich';

// Mermaid needs a layout engine jsdom lacks; KaTeX runs for real.
vi.mock('./rich/mermaid', () => ({
  cachedDiagram: () => null,
  renderDiagram: async () => {
    const fragment = document.createDocumentFragment();
    fragment.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'));
    return fragment;
  },
}));

function entry(path: string, kind: FileEntry['kind']): FileEntry {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return { path, name, basename: name.slice(0, dot), extension: name.slice(dot + 1), kind, size: 1, mtime: '2026-10-21T10:00:00.000Z', version: 'v', aliases: [] };
}

const FILES = [entry('Plan.md', 'note'), entry('Budget.sheet', 'other')];
const TREE = { eventId: 'b.1', folders: [], files: FILES };

// A spreadsheet view as the app registers it: its embed comes from loadEmbed.
function SheetFake(props: EmbedProps) {
  return <span data-testid="sheet-embed">{`${props.path} depth ${props.depth}`}</span>;
}
registerView({ id: 'sheet-test', match: (e) => (e.path.endsWith('.sheet') ? 6 : 0), icon: Sheet, textual: true, modes: ['edit'], load: async () => ({ default: () => null }), loadEmbed: async () => ({ default: SheetFake }) });

const app = {
  path: () => 'Plan.md',
  tree: () => buildVaultTree(TREE),
  renderEmbed: (el: HTMLElement, embed: Parameters<typeof renderLiveEmbed>[1]) => renderLiveEmbed(el, embed, 'Plan.md'),
  renderMarkdown: (el: HTMLElement, block: Parameters<typeof renderLiveMarkdown>[1]) => renderLiveMarkdown(el, block, 'Plan.md'),
  renderMath: renderLiveMath,
};

const NOTE = ['# Plan', '', '> [!warning] Mind the gap', '> - [ ] check the [[Plan]]', '', 'Energy: $E=mc^2$ today.', '', '$$', 'a^2 + b^2 = c^2', '$$', '', '```mermaid', 'graph TD; A-->B', '```', '', '![[Budget.sheet]]', ''].join('\n');

beforeEach(() => {
  queryClient.setQueryData(queryKeys.tree(), TREE);
});

afterEach(() => {
  destroyEditors();
  queryClient.clear();
});

describe('locked Live Preview renders what the reading view rendered', () => {
  it('a callout, inline and block math, a Mermaid diagram and a spreadsheet embed', async () => {
    const view = noteEditor(NOTE, { mode: 'locked', ctx: testContext(app) });
    const dom = view.contentDOM;
    const callout = dom.querySelector('.cm-lp-rich-callout .callout');
    expect(callout).not.toBeNull();
    expect(callout!.getAttribute('data-callout')).toBe('warning');
    expect(callout!.textContent).toContain('Mind the gap');
    expect(callout!.querySelector('a.internal-link')?.textContent).toBe('Plan');
    expect(dom.querySelector('.cm-lp-rich-mermaid [data-mermaid]')).not.toBeNull();
    await waitFor(() => expect(dom.querySelector('.cm-lp-rich-math .katex-display')).not.toBeNull());
    await waitFor(() => expect(dom.querySelector('.cm-lp-math .katex')).not.toBeNull());
    expect(dom.textContent).not.toContain('$E=mc^2$');
    await waitFor(() => expect(dom.querySelector('[data-testid="sheet-embed"]')).toHaveTextContent('Budget.sheet depth 1'));
    // The note itself is untouched.
    expect(view.state.doc.toString()).toBe(NOTE);
  });

  it('a task in a callout toggles in the note, and only its box changes', () => {
    const view = noteEditor(NOTE, { mode: 'locked', ctx: testContext(app) });
    const box = view.contentDOM.querySelector<HTMLInputElement>('.cm-lp-rich-callout input.task-list-item-checkbox')!;
    expect(box.disabled).toBe(false);
    box.click();
    expect(view.state.doc.toString()).toBe(NOTE.replace('> - [ ] check', '> - [x] check'));
  });

  it('a read-only note keeps its callout tasks as they are', () => {
    const view = noteEditor(NOTE, { mode: 'locked', readOnly: true, ctx: testContext(app) });
    const box = view.contentDOM.querySelector<HTMLInputElement>('.cm-lp-rich-callout input.task-list-item-checkbox')!;
    expect(box.disabled).toBe(true);
  });

  it('without the app (a plain editor) the blocks stay text', () => {
    const view = noteEditor(NOTE, { mode: 'locked' });
    expect(view.contentDOM.querySelector('.cm-lp-rich')).toBeNull();
    expect(view.contentDOM.textContent).toContain('$E=mc^2$');
  });
});

describe('rich blocks while editing (Live Preview)', () => {
  it('render while the caret is elsewhere, and show their text while it is in them', () => {
    const view = noteEditor('‸' + NOTE, { ctx: testContext(app) });
    expect(renderedRichBlocks(view.state).map((b) => b.kind)).toEqual(['callout', 'math', 'mermaid']);
    const inCallout = NOTE.indexOf('Mind');
    view.dispatch({ selection: { anchor: inCallout } });
    expect(renderedRichBlocks(view.state).map((b) => b.kind)).toEqual(['math', 'mermaid']);
    expect(view.contentDOM.textContent).toContain('[!warning] Mind the gap');
    // Inline math shows as text while the caret touches it.
    view.dispatch({ selection: { anchor: NOTE.indexOf('$E') + 2 } });
    expect(view.contentDOM.textContent).toContain('$E=mc^2$');
    expect(renderedRichBlocks(view.state).map((b) => b.kind)).toEqual(['callout', 'math', 'mermaid']);
  });

  it('a click on a rendered block puts the caret where its text starts', () => {
    const view = noteEditor('‸' + NOTE, { ctx: testContext(app) });
    const block = view.contentDOM.querySelector<HTMLElement>('.cm-lp-rich-callout')!;
    block.querySelector('.callout-title')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    // The caret goes past the hidden `> ` (hide-all's cursor rule).
    expect(view.state.selection.main.head).toBe(NOTE.indexOf('[!warning]'));
    expect(view.contentDOM.querySelector('.cm-lp-rich-callout')).toBeNull();
  });

  it('a click on a math block or a Mermaid diagram shows its text with the caret at its start (DESIGN §6.6.1)', () => {
    const view = noteEditor('‸' + NOTE, { ctx: testContext(app) });
    view.contentDOM.querySelector('.cm-lp-rich-math')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(view.state.selection.main.head).toBe(NOTE.indexOf('$$\na^2'));
    expect(view.contentDOM.textContent).toContain('a^2 + b^2 = c^2');
    view.contentDOM.querySelector('.cm-lp-rich-mermaid')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(view.state.selection.main.head).toBe(NOTE.indexOf('```mermaid'));
    expect(view.contentDOM.textContent).toContain('graph TD; A-->B');
  });

  it('a click on inline math puts the caret into its TeX', () => {
    const view = noteEditor('‸' + NOTE, { ctx: testContext(app) });
    view.contentDOM.querySelector('.cm-lp-math')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(view.state.selection.main.head).toBe(NOTE.indexOf('$E') + 1);
    expect(view.contentDOM.textContent).toContain('$E=mc^2$');
  });

  it('source mode shows the text', () => {
    const view = noteEditor(NOTE, { mode: 'source', ctx: testContext(app) });
    expect(view.contentDOM.querySelector('.cm-lp-rich, .cm-lp-math')).toBeNull();
  });
});
