import { history } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveEditor } from '../../editor/activeEditor';
import { noteContext, type NoteContext } from '../../editor/context';
import { tableCellHost } from '../../editor/livePreview/table/facets';
import { useUi } from '../../state/ui';
import { MobileToolbar } from './MobileToolbar';
import { registerBuiltins } from '../../extensions/builtins';
import { startVoiceNote } from '../../features/voice/voiceNotes';
import type { DocumentSession } from '../../sync/DocumentSession';
import { documents } from '../../sync/instance';

vi.mock('../../features/voice/voiceNotes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../features/voice/voiceNotes')>()),
  startVoiceNote: vi.fn(),
}));

let view: EditorView;

function mountEditor(doc: string, markdown = true): EditorView {
  const openLink = vi.fn();
  const ctx = { path: () => 'Note.md', openLink, openTag: vi.fn() } as unknown as NoteContext;
  const v = new EditorView({
    state: EditorState.create({ doc, selection: { anchor: doc.length }, extensions: [history(), markdown ? noteContext.of(ctx) : []] }),
    parent: document.body,
  });
  setActiveEditor(v);
  return v;
}

const toolbar = () => screen.getByRole('toolbar', { hidden: true });
const button = (name: string) => screen.getByRole('button', { name, hidden: true });

beforeEach(() => {
  registerBuiltins();
  useUi.setState({ overlay: null });
});

afterEach(() => {
  view?.destroy();
  setActiveEditor(null);
  vi.useRealTimers();
});

describe('MobileToolbar', () => {
  it('is always mounted and shows while the editor has focus', () => {
    view = mountEditor('- task');
    render(<MobileToolbar />);
    expect(toolbar()).not.toHaveClass('is-visible');
    act(() => view.focus());
    expect(toolbar()).toHaveClass('is-visible');
  });

  it('has buttons that never take the focus away from the editor', () => {
    view = mountEditor('- task');
    render(<MobileToolbar />);
    act(() => view.focus());
    for (const b of screen.getAllByRole('button', { hidden: true })) {
      expect(b).toHaveAttribute('tabindex', '-1');
      // A prevented pointerdown keeps the focus (and the iOS keyboard) where it is.
      expect(fireEvent.pointerDown(b)).toBe(false);
    }
    fireEvent.click(button('Toggle checklist'));
    expect(view.state.doc.toString()).toBe('- [ ] task');
    expect(document.activeElement).toBe(view.contentDOM);
    expect(toolbar()).toHaveClass('is-visible');
  });

  it('dispatches its editing tools to the editor', () => {
    view = mountEditor('Some text');
    render(<MobileToolbar />);
    act(() => view.focus());
    fireEvent.click(button('Insert tag'));
    expect(view.state.doc.toString()).toBe('Some text #');
    fireEvent.click(button('Undo'));
    expect(view.state.doc.toString()).toBe('Some text');
    fireEvent.click(button('Redo'));
    expect(view.state.doc.toString()).toBe('Some text #');
    fireEvent.click(button('Horizontal rule'));
    expect(view.state.doc.toString()).toBe('Some text #\n\n---\n');
    fireEvent.click(button('Insert internal link'));
    expect(view.state.doc.toString()).toBe('Some text #\n\n---\n[[]]');
    expect(view.state.selection.main.head).toBe(view.state.doc.length - 2);
  });

  it('has the formatting tools: bold, italic, heading, list, checkbox, link and table, with 44 px targets', () => {
    view = mountEditor('Some text');
    render(<MobileToolbar />);
    act(() => view.focus());
    view.dispatch({ selection: { anchor: 0, head: 4 } });
    fireEvent.click(button('Bold'));
    expect(view.state.doc.toString()).toBe('**Some** text');
    fireEvent.click(button('Italic'));
    expect(view.state.doc.toString()).toBe('***Some*** text');
    fireEvent.click(button('Heading'));
    expect(view.state.doc.toString()).toBe('# ***Some*** text');
    fireEvent.click(button('Heading'));
    expect(view.state.doc.toString()).toBe('## ***Some*** text');
    fireEvent.click(button('Bulleted list'));
    expect(view.state.doc.toString()).toBe('- ***Some*** text');
    view.dispatch({ selection: { anchor: view.state.doc.length - 4, head: view.state.doc.length } });
    fireEvent.click(button('Link'));
    expect(view.state.doc.toString()).toBe('- ***Some*** [text]()');
    for (const name of ['Toggle checklist', 'Insert table']) expect(button(name)).toBeInTheDocument();
    for (const b of screen.getAllByRole('button', { hidden: true })) expect(b).toHaveClass('mobile-toolbar-button');
  });

  it('keeps the inline formatting tools in a table cell, without the line tools', () => {
    const note = mountEditor('note');
    const ctx = { path: () => 'Note.md' } as unknown as NoteContext;
    view = new EditorView({ state: EditorState.create({ doc: 'cell', extensions: [noteContext.of(ctx), tableCellHost.of(note)] }), parent: document.body });
    setActiveEditor(view);
    render(<MobileToolbar />);
    act(() => view.focus());
    for (const name of ['Bold', 'Italic', 'Link', 'Inline code']) expect(button(name)).toBeInTheDocument();
    for (const name of ['Heading', 'Bulleted list']) expect(screen.queryByRole('button', { name, hidden: true })).toBeNull();
    note.destroy();
  });

  it('opens the command palette and hides the keyboard', () => {
    view = mountEditor('x');
    render(<MobileToolbar />);
    act(() => view.focus());
    fireEvent.click(button('Command palette'));
    expect(useUi.getState().overlay).toBe('palette');
    fireEvent.click(button('Hide keyboard'));
    expect(view.hasFocus).toBe(false);
  });

  it('hides after the editor has been blurred for a moment', () => {
    vi.useFakeTimers();
    view = mountEditor('x');
    render(<MobileToolbar />);
    act(() => view.focus());
    act(() => view.contentDOM.blur());
    expect(toolbar()).toHaveClass('is-visible');
    act(() => vi.advanceTimersByTime(200));
    expect(toolbar()).not.toHaveClass('is-visible');
  });

  it('offers Previous and Next cell in a table cell, and undoes in its note', () => {
    const note = mountEditor('note');
    note.dispatch({ changes: { from: 4, insert: '!' } });
    const ctx = { path: () => 'Note.md' } as unknown as NoteContext;
    view = new EditorView({ state: EditorState.create({ doc: 'cell', extensions: [noteContext.of(ctx), tableCellHost.of(note)] }), parent: document.body });
    setActiveEditor(view);
    render(<MobileToolbar />);
    act(() => view.focus());
    expect(button('Previous cell')).toBeInTheDocument();
    expect(button('Next cell')).toBeInTheDocument();
    for (const name of ['Toggle checklist', 'Horizontal rule', 'Insert table', 'Insert image', 'Indent']) {
      expect(screen.queryByRole('button', { name, hidden: true })).toBeNull();
    }
    fireEvent.click(button('Undo'));
    expect(note.state.doc.toString()).toBe('note');
    note.destroy();
  });

  it('inserts a table from the toolbar', () => {
    view = mountEditor('');
    render(<MobileToolbar />);
    act(() => view.focus());
    expect(screen.queryByRole('button', { name: 'Previous cell', hidden: true })).toBeNull();
    fireEvent.click(button('Insert table'));
    expect(view.state.doc.toString()).toBe(['|     |     |', '| --- | --- |', '|     |     |', '|     |     |'].join('\n'));
  });

  it('offers only the generic tools in a plain-text editor', () => {
    view = mountEditor('{"a": 1}', false);
    render(<MobileToolbar />);
    act(() => view.focus());
    expect(screen.queryByRole('button', { name: 'Insert tag', hidden: true })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Record voice note', hidden: true })).toBeNull();
    expect(button('Indent')).toBeInTheDocument();
  });

  it('records a voice note into the note, and puts the keyboard away for the recording panel', () => {
    const session = { path: 'Note.md' } as DocumentSession;
    vi.spyOn(documents, 'get').mockImplementation((path) => (path === 'Note.md' ? session : undefined));
    view = mountEditor('Some text');
    render(<MobileToolbar />);
    act(() => view.focus());
    fireEvent.click(button('Record voice note'));
    expect(startVoiceNote).toHaveBeenCalledWith(session);
    expect(document.activeElement).not.toBe(view.contentDOM);
  });
});
