// Script and Dataview blocks in Live Preview and locked notes (ROADMAP items 40 and 17, DESIGN §6.43):
// what shows, when they run, and what is removed from their output.
import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from '../../api/queryClient';
import { queryKeys } from '../../api/queryKeys';
import { renderLiveMarkdown } from '../../render/liveRich';
import { destroyEditors, noteEditor, testContext } from '../../test/noteEditor';
import type { ScriptOutcome, ScriptRequest } from '../context';
import { renderedRichBlocks } from './rich';
import { fencedCode, invalidateScripts, resetScriptsForTests } from './scripts';

const TREE = { eventId: 'b.1', folders: [], files: [] };

function outcome(markdown: string, extra: Partial<ScriptOutcome> = {}): ScriptOutcome {
  return { markdown, error: null, reads: { paths: new Set(), broad: false }, ...extra };
}

function app(run: (r: ScriptRequest) => Promise<ScriptOutcome>) {
  return testContext({
    path: () => 'Here.md',
    renderMarkdown: (el, block) => renderLiveMarkdown(el, block, 'Here.md'),
    runScript: run,
  });
}

const NOTE = ['# Here', '', '```script', 'show("**hi**")', '```', '', 'after'].join('\n');

beforeEach(() => {
  queryClient.setQueryData(queryKeys.tree(), TREE);
  resetScriptsForTests();
});

afterEach(() => {
  destroyEditors();
  queryClient.clear();
  resetScriptsForTests();
});

describe('fencedCode', () => {
  it('takes the lines between the fences', () => {
    expect(fencedCode('```script\na\nb\n```')).toBe('a\nb');
    expect(fencedCode('````dataview\nLIST\n````')).toBe('LIST');
    // Unclosed: to the end.
    expect(fencedCode('```script\na\nb')).toBe('a\nb');
    // A shorter fence does not close a longer one.
    expect(fencedCode('````script\na\n```')).toBe('a\n```');
    expect(fencedCode('```script\n```')).toBe('');
  });
});

describe('script blocks', () => {
  it('a locked note shows the output, and </> shows the code under it', async () => {
    const run = vi.fn(async (r: ScriptRequest) => outcome(`**${r.source.length}**`));
    const view = noteEditor(NOTE, { mode: 'locked', ctx: app(run) });
    const block = view.contentDOM.querySelector<HTMLElement>('.cm-lp-script-script')!;
    expect(block).not.toBeNull();
    await waitFor(() => expect(block.querySelector('.cm-lp-script-output strong')?.textContent?.trim()).toBe(String('show("**hi**")'.length)));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toMatchObject({ kind: 'script', source: 'show("**hi**")' });
    const code = block.querySelector<HTMLElement>('pre.cm-lp-script-code')!;
    expect(code.hidden).toBe(true);
    block.querySelector<HTMLButtonElement>('.is-code')!.click();
    expect(code.hidden).toBe(false);
    expect(code.textContent).toBe('show("**hi**")');
    // The note is untouched.
    expect(view.state.doc.toString()).toBe(NOTE);
  });

  it('while editing, the code shows while the caret is in the block; leaving it does not run it again', async () => {
    const run = vi.fn(async () => outcome('done'));
    const view = noteEditor('‸' + NOTE, { ctx: app(run) });
    expect(renderedRichBlocks(view.state).map((b) => b.kind)).toEqual(['script']);
    await waitFor(() => expect(view.contentDOM.querySelector('.cm-lp-script-output')?.textContent?.trim()).toBe('done'));
    view.dispatch({ selection: { anchor: NOTE.indexOf('show') } });
    expect(view.contentDOM.querySelector('.cm-lp-script')).toBeNull();
    expect(view.contentDOM.textContent).toContain('show("**hi**")');
    view.dispatch({ selection: { anchor: 0 } });
    expect(view.contentDOM.querySelector('.cm-lp-script-output')?.textContent?.trim()).toBe('done');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('</> while editing puts the caret in the code', async () => {
    const view = noteEditor('‸' + NOTE, { ctx: app(async () => outcome('x')) });
    view.contentDOM.querySelector<HTMLButtonElement>('.cm-lp-script .is-code')!.click();
    expect(view.state.selection.main.head).toBe(NOTE.indexOf('show'));
    expect(view.contentDOM.querySelector('.cm-lp-script')).toBeNull();
  });

  it('↻ runs it again', async () => {
    let n = 0;
    const view = noteEditor(NOTE, { mode: 'locked', ctx: app(async () => outcome(`run ${++n}`)) });
    await waitFor(() => expect(view.contentDOM.querySelector('.cm-lp-script-output')?.textContent?.trim()).toBe('run 1'));
    view.contentDOM.querySelector<HTMLButtonElement>('.cm-lp-script .is-rerun')!.click();
    await waitFor(() => expect(view.contentDOM.querySelector('.cm-lp-script-output')?.textContent?.trim()).toBe('run 2'));
  });

  it('shows an error with its line, under what the script showed before it', async () => {
    const view = noteEditor(NOTE, { mode: 'locked', ctx: app(async () => outcome('before', { error: { kind: 'script', line: 2, message: 'ReferenceError: x is not defined' } })) });
    await waitFor(() => expect(view.contentDOM.querySelector('.cm-lp-script-error')?.textContent?.trim()).toBe('Line 2: ReferenceError: x is not defined'));
    expect(view.contentDOM.querySelector('.cm-lp-script-output')?.textContent?.trim()).toBe('before');
  });

  it('removes images from other sites from the output, without a way to load them', async () => {
    const view = noteEditor(NOTE, { mode: 'locked', config: { remoteImages: true }, ctx: app(async () => outcome('![secret](https://evil.example/x.png?d=1) and <img src="https://evil.example/y.png">')) });
    await waitFor(() => expect(view.contentDOM.querySelector('.cm-lp-script-output')).not.toBeNull());
    const out = view.contentDOM.querySelector('.cm-lp-script-output')!;
    expect(out.querySelector('img')).toBeNull();
    expect(out.querySelector('.remote-image-placeholder')).toBeNull();
    expect(out.innerHTML).not.toContain('evil.example');
    expect(out.querySelectorAll('.cm-lp-script-noimage')).toHaveLength(2);
  });

  it('runs again (debounced) when a note it read changes, and not for other notes', async () => {
    let n = 0;
    const run = vi.fn(async () => outcome(`run ${++n}`, { reads: { paths: new Set(['Other.md']), broad: false } }));
    const view = noteEditor(NOTE, { mode: 'locked', ctx: app(run) });
    await waitFor(() => expect(view.contentDOM.querySelector('.cm-lp-script-output')?.textContent?.trim()).toBe('run 1'));
    invalidateScripts(['Unrelated.md']);
    invalidateScripts(['Other.md']);
    invalidateScripts(['Other.md']);
    await waitFor(() => expect(view.contentDOM.querySelector('.cm-lp-script-output')?.textContent?.trim()).toBe('run 2'), { timeout: 3000 });
    await new Promise((r) => setTimeout(r, 1200));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a script that listed notes runs again for any note', async () => {
    let n = 0;
    const view = noteEditor(NOTE, { mode: 'locked', ctx: app(async () => outcome(`run ${++n}`, { reads: { paths: new Set(), broad: true } })) });
    await waitFor(() => expect(view.contentDOM.querySelector('.cm-lp-script-output')?.textContent?.trim()).toBe('run 1'));
    invalidateScripts(['Anything.md']);
    await waitFor(() => expect(view.contentDOM.querySelector('.cm-lp-script-output')?.textContent?.trim()).toBe('run 2'), { timeout: 3000 });
  });

  it('"ask" shows the code and a Run button first', async () => {
    const run = vi.fn(async () => outcome('ran'));
    const view = noteEditor(NOTE, { mode: 'locked', config: { scripts: 'ask' }, ctx: app(run) });
    const block = view.contentDOM.querySelector<HTMLElement>('.cm-lp-script')!;
    expect(block.querySelector('.cm-lp-script-ask pre')?.textContent?.trim()).toBe('show("**hi**")');
    await new Promise((r) => setTimeout(r, 20));
    expect(run).not.toHaveBeenCalled();
    block.querySelector<HTMLButtonElement>('.is-run')!.click();
    await waitFor(() => expect(block.querySelector('.cm-lp-script-output')?.textContent?.trim()).toBe('ran'));
  });

  it('"off" leaves the code, as does an editor without the app', () => {
    const run = vi.fn(async () => outcome('ran'));
    const off = noteEditor(NOTE, { mode: 'locked', config: { scripts: 'off' }, ctx: app(run) });
    expect(off.contentDOM.querySelector('.cm-lp-script')).toBeNull();
    expect(off.contentDOM.textContent).toContain('show("**hi**")');
    const plain = noteEditor(NOTE, { mode: 'locked' });
    expect(plain.contentDOM.querySelector('.cm-lp-script')).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it('a dataview block runs as a query; dataviewjs stays code', async () => {
    const run = vi.fn(async (r: ScriptRequest) => outcome(r.kind));
    const text = ['```dataview', 'LIST FROM #a', '```', '', '```dataviewjs', 'dv.list([])', '```'].join('\n');
    const view = noteEditor(text, { mode: 'locked', ctx: app(run) });
    await waitFor(() => expect(view.contentDOM.querySelector('.cm-lp-script-dataview .cm-lp-script-output')?.textContent?.trim()).toBe('dataview'));
    expect(run.mock.calls[0][0]).toMatchObject({ kind: 'dataview', source: 'LIST FROM #a' });
    expect(view.contentDOM.querySelectorAll('.cm-lp-script')).toHaveLength(1);
    expect(view.contentDOM.textContent).toContain('dv.list([])');
  });

  it('evaluates formulas with the note’s tables', async () => {
    let value: unknown = null;
    const text = ['| a | b |', '| - | - |', '| 2 | 3 |', '', '```script', 'x', '```'].join('\n');
    noteEditor(text, {
      mode: 'locked',
      ctx: app(async (r) => {
        value = await r.evaluate('=SUM(Table1!A2:B2)', true);
        return outcome(String(value));
      }),
    });
    await waitFor(() => expect(value).toBe(5), { timeout: 5000 });
  });
});
