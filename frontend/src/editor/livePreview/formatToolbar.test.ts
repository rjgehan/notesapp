import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { destroyEditors, noteEditor } from '../../test/noteEditor';
import type { EditorMenuEntry } from '../context';

afterEach(() => {
  destroyEditors();
  vi.restoreAllMocks();
});

const toolbar = (view: EditorView) => view.dom.querySelector<HTMLElement>('.cm-format-toolbar');
const button = (view: EditorView, label: string) => toolbar(view)!.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

function select(view: EditorView, anchor: number, head: number): void {
  view.focus();
  view.dispatch({ selection: EditorSelection.single(anchor, head), userEvent: 'select' });
}

describe('the selection toolbar (ROADMAP 10a)', () => {
  it('shows over selected text with the formatting buttons, and none without a selection', () => {
    const view = noteEditor('a word b');
    view.focus();
    expect(toolbar(view)).toBeNull();
    select(view, 2, 6);
    const bar = toolbar(view)!;
    expect(bar).not.toBeNull();
    expect(bar.hidden).toBe(false);
    expect([...bar.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Bold', 'Italic', 'Strikethrough', 'Highlight', 'Inline code', 'Link', 'Heading']);
    expect(button(view, 'Bold').title).toBe('Bold (Ctrl+B)');
    select(view, 3, 3);
    expect(toolbar(view)).toBeNull();
  });

  it('its buttons format the selection, show what it has, and keep the focus in the note', () => {
    const view = noteEditor('a word b');
    select(view, 2, 6);
    expect(button(view, 'Bold').getAttribute('aria-pressed')).toBe('false');
    // A prevented mousedown keeps the selection and the focus.
    expect(fireEvent.mouseDown(button(view, 'Bold'))).toBe(false);
    fireEvent.click(button(view, 'Bold'));
    expect(view.state.doc.toString()).toBe('a **word** b');
    expect(button(view, 'Bold').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button(view, 'Highlight'));
    expect(view.state.doc.toString()).toBe('a **==word==** b');
    fireEvent.click(button(view, 'Link'));
    expect(view.state.doc.toString()).toBe('a **==[word]()==** b');
    expect(view.hasFocus).toBe(true);
  });

  it('waits for the mouse button to come up after a drag selection', () => {
    const view = noteEditor('a word b');
    view.focus();
    fireEvent.mouseDown(view.contentDOM, { button: 0 });
    view.dispatch({ selection: EditorSelection.single(2, 6), userEvent: 'select.pointer' });
    expect(toolbar(view)).toBeNull();
    fireEvent.mouseUp(window);
    expect(toolbar(view)).not.toBeNull();
  });

  it('the heading button opens a menu of levels for the selected lines', () => {
    const showMenu = vi.fn((_at: { x: number; y: number }, _label: string, items: EditorMenuEntry[]) => {
      const h2 = items.find((i) => i !== 'separator' && i.id === 'h2');
      if (h2 && h2 !== 'separator') h2.run();
    });
    const view = noteEditor('Title here', { ctx: { showMenu } });
    select(view, 0, 5);
    fireEvent.click(button(view, 'Heading'));
    expect(showMenu).toHaveBeenCalledOnce();
    expect(showMenu.mock.calls[0][2].map((i) => (i === 'separator' ? i : i.label))).toEqual(['Normal text', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6']);
    expect(view.state.doc.toString()).toBe('## Title here');
  });

  it('is not there in a locked note or in source mode', () => {
    for (const mode of ['locked', 'source'] as const) {
      const view = noteEditor('a word b', { mode });
      select(view, 2, 6);
      expect(toolbar(view)).toBeNull();
    }
  });
});
