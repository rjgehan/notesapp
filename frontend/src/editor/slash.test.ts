import { CompletionContext, type Completion, type CompletionResult } from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { dayjs } from '../features/dates';
import { DEFAULT_SETTINGS } from '../features/settings';
import { destroyEditors, marked, noteEditor, parsed } from '../test/noteEditor';
import { publishVimMode, clearVimMode } from './vimMode';
import { openSlashMenu, registerSlashItem, slashMenuClass, slashSource } from './slash';

afterEach(destroyEditors);

function menu(view: EditorView): CompletionResult | null {
  return slashSource(new CompletionContext(view.state, view.state.selection.main.head, false, view)) as CompletionResult | null;
}

function labels(view: EditorView): string[] {
  return menu(view)?.options.map((o) => o.label) ?? [];
}

function pick(view: EditorView, label: string): void {
  const result = menu(view)!;
  const option = result.options.find((o) => o.label === label) as Completion;
  expect(option, `option ${label}`).toBeDefined();
  (option.apply as (v: EditorView, c: Completion, f: number, t: number) => void)(view, option, result.from, view.state.selection.main.head);
  parsed(view);
}

describe('the / menu', () => {
  it('opens at a line start and after a space, not inside a word', () => {
    expect(labels(noteEditor('/‸'))).toContain('Heading 1');
    expect(labels(noteEditor('text /‸'))).toContain('Table');
    expect(labels(noteEditor('- /‸'))).toContain('Checklist');
    expect(menu(noteEditor('and/‸'))).toBeNull();
    expect(menu(noteEditor('1/2‸'))).toBeNull();
  });

  it('filters fuzzily over labels and keywords, and closes when nothing matches', () => {
    expect(labels(noteEditor('/h2‸'))[0]).toBe('Heading 2');
    expect(labels(noteEditor('/tabl‸'))[0]).toBe('Table');
    expect(labels(noteEditor('/hr‸'))).toContain('Divider');
    expect(labels(noteEditor('/todo‸'))).toContain('Checklist');
    expect(menu(noteEditor('/usr/bin‸'))).toBeNull();
    expect(menu(noteEditor('/zzzzqqq‸'))).toBeNull();
  });

  it('is not offered in code, math, frontmatter, links or a read-only note', () => {
    expect(menu(noteEditor('```\n/‸\n```'))).toBeNull();
    expect(menu(noteEditor('a `x /‸` b'))).toBeNull();
    expect(menu(noteEditor('$$\n/‸\n$$'))).toBeNull();
    expect(menu(noteEditor('---\ntitle: /‸\n---\n'))).toBeNull();
    expect(menu(noteEditor('[[Note /‸]]'))).toBeNull();
    expect(menu(noteEditor('/‸', { mode: 'locked' }))).toBeNull();
    expect(menu(noteEditor('/‸', { readOnly: true }))).toBeNull();
  });

  it('is not offered while vim is in normal mode', () => {
    const view = noteEditor('/‸', { mode: 'source' });
    publishVimMode(view, 'NORMAL');
    expect(menu(view)).toBeNull();
    publishVimMode(view, 'INSERT');
    expect(menu(view)).not.toBeNull();
    clearVimMode(view);
  });

  it('offers only text at the cursor on a table line (source mode)', () => {
    const view = noteEditor('| a | b |\n| - | - |\n| x /‸ | y |', { mode: 'source' });
    const offered = labels(view);
    expect(offered).toContain('Internal link');
    expect(offered).toContain('Today');
    expect(offered).not.toContain('Heading 1');
    expect(offered).not.toContain('Table');
  });

  it('removes the typed query and runs the line commands', () => {
    let view = noteEditor('/h1‸', { mode: 'source' });
    pick(view, 'Heading 1');
    expect(marked(view)).toBe('# ‸');

    view = noteEditor('Groceries /bul‸', { mode: 'source' });
    pick(view, 'Bulleted list');
    expect(marked(view)).toBe('- Groceries ‸');

    view = noteEditor('/check‸', { mode: 'source' });
    pick(view, 'Checklist');
    expect(marked(view)).toBe('- [ ] ‸');

    view = noteEditor('1. one\n/num‸', { mode: 'source' });
    pick(view, 'Numbered list');
    expect(marked(view)).toBe('1. one\n2. ‸');

    view = noteEditor('/quo‸', { mode: 'source' });
    pick(view, 'Quote');
    expect(marked(view)).toBe('> ‸');
  });

  it('inserts blocks on a blank line, or after the line, kept apart by blank lines', () => {
    let view = noteEditor('/calloutwarn‸', { mode: 'source' });
    pick(view, 'Callout: Warning');
    expect(marked(view)).toBe('> [!warning]\n> ‸');

    view = noteEditor('Intro /code‸\nNext', { mode: 'source' });
    pick(view, 'Code block');
    expect(marked(view)).toBe('Intro \n\n```‸\n```\n\nNext');

    view = noteEditor('/python‸', { mode: 'source' });
    pick(view, 'Code: Python');
    expect(marked(view)).toBe('```python\n‸\n```');

    view = noteEditor('/math‸', { mode: 'source' });
    pick(view, 'Math block');
    expect(marked(view)).toBe('$$\n‸\n$$');

    view = noteEditor('/mermaid‸', { mode: 'source' });
    pick(view, 'Mermaid diagram');
    expect(marked(view)).toBe('```mermaid\nflowchart TD\n    A --> B‸\n```');

    view = noteEditor('Text\n/div‸', { mode: 'source' });
    pick(view, 'Divider');
    expect(view.state.doc.toString()).toBe('Text\n\n---\n');

    view = noteEditor('/table‸', { mode: 'source' });
    pick(view, 'Table');
    expect(view.state.doc.toString()).toMatch(/^\| +\| +\|\n\| -+ \| -+ \|(\n\| +\| +\|)+$/);
  });

  it('inserts links, embeds and dates at the cursor', () => {
    let view = noteEditor('See /inter‸', { mode: 'source' });
    pick(view, 'Internal link');
    expect(marked(view)).toBe('See [[‸]]');

    view = noteEditor('/embed‸', { mode: 'source' });
    pick(view, 'Embed');
    expect(marked(view)).toBe('![[‸]]');

    view = noteEditor('/block‸', { mode: 'source' });
    pick(view, 'Block reference');
    expect(marked(view)).toBe('[[#^‸]]');

    view = noteEditor('Due /today‸', { mode: 'source' });
    pick(view, 'Today');
    expect(view.state.doc.toString()).toBe(`Due ${dayjs().format(DEFAULT_SETTINGS.templates.dateFormat)}`);

    view = noteEditor('/tomorrow‸', { mode: 'source' });
    expect(menu(view)!.options[0].detail).toBe(dayjs().add(1, 'day').format(DEFAULT_SETTINGS.templates.dateFormat));
  });

  it('runs registered items, hidden while their condition fails', () => {
    let ran = 0;
    let available = false;
    registerSlashItem({ id: 'test.item', label: 'Zebra stripes', group: 'Test', scope: 'block', order: 1, when: () => available, run: () => ran++ });
    const view = noteEditor('/zebra‸', { mode: 'source' });
    expect(labels(view)).not.toContain('Zebra stripes');
    available = true;
    pick(view, 'Zebra stripes');
    expect(ran).toBe(1);
    expect(view.state.doc.toString()).toBe('');
  });

  it('marks its tooltip, and the Insert button types a slash and opens it', () => {
    const view = noteEditor('word‸', { mode: 'source' });
    expect(slashMenuClass(view.state)).toBe('');
    openSlashMenu(view);
    expect(marked(view)).toBe('word /‸');
  });
});
