// One file in two panes (ROADMAP item 11, DESIGN §6.38): two editors over one DocumentSession.
import { undo } from '@codemirror/commands';
import { StateEffect } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockVault } from '../api/mock/vault';
import { noteExtensions } from '../editor/editorSetup';
import { fakeApi, sessionDeps } from '../test/fakes';
import { testContext } from '../test/noteEditor';
import { DocumentSession } from './DocumentSession';

function setup(content = 'hello') {
  const vault = new MockVault(false);
  vault.createFile({ path: 'a.md', content }, 'other-device-1');
  const fake = fakeApi(vault);
  const session = new DocumentSession('a.md', sessionDeps(fake.api));
  return { vault, fake, session };
}

/** An editor mounted the way NoteEditor mounts one, in Live Preview. */
function mount(session: DocumentSession): EditorView {
  const hooks = {
    onLocalChange: () => session.markDirty(),
    onBlur: () => {},
    readOnly: false,
    spellcheck: false,
    autocorrect: false,
    livePreview: { visibility: 'hide-all' as const, locked: false, checkboxes: true },
  };
  const state = session.prepareState((st) => st.update({ effects: StateEffect.reconfigure.of([noteExtensions(testContext(), hooks)]) }).state);
  const view = new EditorView({ state, dispatchTransactions: (trs, v) => session.routeTransactions(v, trs) });
  session.attach(view);
  return view;
}

function unmount(session: DocumentSession, view: EditorView): void {
  session.detach(view);
  view.destroy();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a file in two panes', () => {
  it('keeps both editors equal, saves once, and shows no conflict', async () => {
    const { vault, fake, session } = setup();
    await session.ready;
    const left = mount(session);
    const right = mount(session);
    expect(session.editorCount).toBe(2);
    left.dispatch({ changes: { from: 5, insert: ' left' }, userEvent: 'input.type' });
    right.dispatch({ changes: { from: 0, insert: 'right ' }, userEvent: 'input.type' });
    expect(left.state.doc.toString()).toBe('right hello left');
    expect(right.state.doc.toString()).toBe('right hello left');
    expect(session.getSnapshot().status).toBe('dirty');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.api.saveFile).toHaveBeenCalledTimes(1);
    expect(vault.readFile('a.md').content).toBe('right hello left');
    expect(session.getSnapshot().status).toBe('clean');
    unmount(session, left);
    unmount(session, right);
  });

  it('applies another device’s change to both editors without marking the file dirty', async () => {
    const { vault, session } = setup();
    await session.ready;
    const left = mount(session);
    const right = mount(session);
    vault.externalWrite('a.md', 'hello from afar');
    await session.onRemoteChanged({ version: vault.readFile('a.md').version });
    expect(left.state.doc.toString()).toBe('hello from afar');
    expect(right.state.doc.toString()).toBe('hello from afar');
    expect(session.getSnapshot().status).toBe('clean');
    unmount(session, left);
    unmount(session, right);
  });

  it('each pane undoes its own edits', async () => {
    const { session } = setup('abc');
    await session.ready;
    const left = mount(session);
    const right = mount(session);
    left.dispatch({ changes: { from: 3, insert: 'L' }, userEvent: 'input.type' });
    right.dispatch({ changes: { from: 0, insert: 'R' }, userEvent: 'input.type' });
    undo(right);
    expect(left.state.doc.toString()).toBe('abcL');
    expect(right.state.doc.toString()).toBe('abcL');
    unmount(session, left);
    unmount(session, right);
  });

  it('keeps the main undo history when its pane closes first, and after both remount', async () => {
    const { session } = setup('abc');
    await session.ready;
    const main = mount(session);
    main.dispatch({ changes: { from: 3, insert: '1' }, userEvent: 'input.type' });
    const other = mount(session);
    other.dispatch({ changes: { from: 0, insert: 'x' }, userEvent: 'input.type' });
    // A mode switch remounts both editors: the main history comes back to the first one.
    unmount(session, main);
    expect(session.editorState.doc.toString()).toBe('xabc1');
    unmount(session, other);
    const again = mount(session);
    expect(again.state.doc.toString()).toBe('xabc1');
    undo(again);
    expect(again.state.doc.toString()).toBe('xabc');
    unmount(session, again);
  });
});
