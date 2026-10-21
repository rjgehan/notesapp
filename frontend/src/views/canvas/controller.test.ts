import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockVault } from '../../api/mock/vault';
import { useToasts } from '../../state/toasts';
import { fakeApi, sessionDeps } from '../../test/fakes';
import { DocumentSession } from '../../sync/DocumentSession';
import { CanvasController } from './controller';
import { OBSIDIAN_SAMPLE } from './fixtures.test-data';
import { parseCanvas, serializeCanvas } from './format';
import { moveNodes, updateNode } from './ops';

const PATH = 'Board.canvas';
const TEXT = '59e896bc8da20699';
const PLAN = '8132d4d894c80022';

async function setup(content = OBSIDIAN_SAMPLE) {
  const vault = new MockVault(false);
  vault.createFile({ path: PATH, content }, 'other-device-1');
  const fake = fakeApi(vault);
  const session = new DocumentSession(PATH, sessionDeps(fake.api));
  await session.ready;
  const controller = new CanvasController();
  controller.bind(session);
  return { vault, fake, session, controller };
}

const saved = (vault: MockVault) => vault.readFile(PATH).content;
const version = (vault: MockVault) => vault.readFile(PATH).version;

beforeEach(() => {
  vi.useFakeTimers();
  useToasts.setState({ toasts: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CanvasController and the document session', () => {
  it('reads the session and writes each operation back, which autosaves', async () => {
    const { vault, session, controller } = await setup();
    expect(controller.getState().doc?.nodes).toHaveLength(5);
    expect(controller.getState().readOnly).toBe(false);
    controller.moveSelection(new Set([PLAN]), 40, 0);
    expect(session.getSnapshot().status).toBe('dirty');
    await vi.advanceTimersByTimeAsync(1000);
    expect(session.getSnapshot().status).toBe('clean');
    const lines = saved(vault).split('\n');
    expect(lines[3]).toContain('"x":-240');
    // Only the moved node's line changed.
    expect(lines.filter((l, i) => l !== OBSIDIAN_SAMPLE.split('\n')[i])).toHaveLength(1);
  });

  it('undo brings back the exact bytes, and redo the edit', async () => {
    const { vault, controller } = await setup();
    controller.updateNode(TEXT, { text: 'Changed' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved(vault)).toContain('"text":"Changed"');
    controller.undo();
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved(vault)).toBe(OBSIDIAN_SAMPLE);
    expect(controller.getState().canRedo).toBe(true);
    controller.redo();
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved(vault)).toContain('"text":"Changed"');
  });

  it('writes typing after a pause, as one undo step', async () => {
    const { session, controller } = await setup();
    controller.startEditing(TEXT);
    controller.setNodeText(TEXT, 'a');
    controller.setNodeText(TEXT, 'ab');
    expect(session.getSnapshot().status).toBe('clean');
    await vi.advanceTimersByTimeAsync(250);
    expect(session.getText()).toContain('"text":"ab"');
    controller.stopEditing();
    controller.undo();
    expect(controller.getState().doc?.nodes.find((n) => n.id === TEXT)?.text).toContain('Learn more');
    expect(controller.getState().canUndo).toBe(false);
  });

  it('adopts a remote change while clean', async () => {
    const { vault, session, controller } = await setup();
    controller.select([TEXT]);
    controller.updateNode(PLAN, { color: '1' });
    await vi.advanceTimersByTimeAsync(1000);
    const theirs = serializeCanvas(updateNode(parseCanvas(saved(vault)), TEXT, { text: 'From the phone' }));
    vault.externalWrite(PATH, theirs);
    await session.onRemoteChanged({ version: version(vault) });
    const doc = controller.getState().doc!;
    expect(doc.nodes.find((n) => n.id === TEXT)?.text).toBe('From the phone');
    expect(doc.nodes.find((n) => n.id === PLAN)?.color).toBe('1');
    expect(controller.getState().selection.nodes.has(TEXT)).toBe(true);
    // The other device's change is not this device's to undo.
    expect(controller.getState().canUndo).toBe(false);
  });

  it('merges a remote change into unsaved local edits and saves the result', async () => {
    const { vault, session, controller } = await setup();
    controller.moveSelection(new Set([PLAN]), 100, 0);
    const theirs = serializeCanvas(updateNode(parseCanvas(OBSIDIAN_SAMPLE), TEXT, { text: 'From the phone' }));
    vault.externalWrite(PATH, theirs);
    await session.onRemoteChanged({ version: version(vault) });
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getSnapshot().status).toBe('clean');
    const doc = parseCanvas(saved(vault));
    expect(doc.nodes.find((n) => n.id === TEXT)?.text).toBe('From the phone');
    expect(doc.nodes.find((n) => n.id === PLAN)?.x).toBe(-180);
    expect(controller.getState().doc?.nodes.find((n) => n.id === TEXT)?.text).toBe('From the phone');
    expect(useToasts.getState().toasts.map((t) => t.message)).toContain('Merged changes from another device');
  });

  it('leaves a real conflict to the banner, and Take theirs replaces the board', async () => {
    const { vault, session, controller } = await setup();
    controller.updateNode(TEXT, { text: 'Mine' });
    const theirs = serializeCanvas(updateNode(parseCanvas(OBSIDIAN_SAMPLE), TEXT, { text: 'Theirs' }));
    vault.externalWrite(PATH, theirs);
    await session.onRemoteChanged({ version: version(vault) });
    expect(session.getSnapshot().status).toBe('conflict');
    expect(controller.getState().doc?.nodes.find((n) => n.id === TEXT)?.text).toBe('Mine');
    await session.takeTheirs();
    expect(controller.getState().doc?.nodes.find((n) => n.id === TEXT)?.text).toBe('Theirs');
  });

  it('shows text that is not a canvas as an error until it is one again', async () => {
    const { vault, session, controller } = await setup();
    vault.externalWrite(PATH, '{ broken');
    await session.onRemoteChanged({ version: version(vault) });
    expect(controller.getState().doc).toBeNull();
    expect(controller.getState().error).toMatch(/not valid JSON/);
    vault.externalWrite(PATH, OBSIDIAN_SAMPLE);
    await session.onRemoteChanged({ version: version(vault) });
    expect(controller.getState().doc?.nodes).toHaveLength(5);
  });

  it('writes pending typing when it unbinds (route change)', async () => {
    const { session, controller } = await setup();
    controller.setNodeText(TEXT, 'Last words');
    controller.unbind();
    expect(session.getText()).toContain('"text":"Last words"');
  });

  it('follows files that moved', async () => {
    const { session, controller } = await setup();
    controller.followMoves((p) => (p === 'Projects/Plan.md' ? 'Archive/Plan.md' : null));
    expect(session.getText()).toContain('"file":"Archive/Plan.md"');
    const unchanged = controller.getState().doc;
    controller.followMoves(() => null);
    expect(controller.getState().doc).toBe(unchanged);
  });

  it('copies, pastes next to the original and duplicates', async () => {
    const { controller } = await setup();
    controller.select([TEXT, PLAN]);
    const text = controller.copySelection();
    expect(JSON.parse(text!).nodes).toHaveLength(2);
    controller.pasteFragment(CanvasController.pageClipboard()!.fragment);
    const doc = controller.getState().doc!;
    expect(doc.nodes).toHaveLength(7);
    const pasted = doc.nodes.slice(-2);
    expect(controller.getState().selection.nodes).toEqual(new Set(pasted.map((n) => n.id)));
    controller.duplicateSelection();
    expect(controller.getState().doc!.nodes).toHaveLength(9);
  });

  it('does not edit a read-only (lossy) file', async () => {
    const { controller } = await setup();
    const doc = controller.getState().doc!;
    // Simulate what a lossy file's session reports.
    (controller as unknown as { set(p: object): void }).set({ readOnly: true });
    controller.moveSelection(new Set([PLAN]), 10, 0);
    expect(controller.getState().doc).toBe(doc);
    expect(moveNodes(doc, new Set([PLAN]), 0, 0)).toBe(doc);
  });
});

describe('CanvasController viewport', () => {
  it('zooms around a point and fits the board', async () => {
    const { controller } = await setup();
    controller.setStage(1000, 800);
    controller.setView({ x: 0, y: 0, zoom: 1 });
    controller.zoomAt(2, { x: 100, y: 100 });
    expect(controller.getState().view).toEqual({ x: -100, y: -100, zoom: 2 });
    expect(controller.screenToWorld({ x: 100, y: 100 })).toEqual({ x: 100, y: 100 });
    controller.zoomToFit();
    const v = controller.getState().view;
    expect(v.zoom).toBeLessThanOrEqual(1);
    // Every node is inside the stage.
    for (const n of controller.getState().doc!.nodes) {
      const tl = controller.worldToScreen({ x: n.x, y: n.y });
      const br = controller.worldToScreen({ x: n.x + n.width, y: n.y + n.height });
      expect(tl.x).toBeGreaterThanOrEqual(0);
      expect(tl.y).toBeGreaterThanOrEqual(0);
      expect(br.x).toBeLessThanOrEqual(1000);
      expect(br.y).toBeLessThanOrEqual(800);
    }
  });

  it('keeps the centre when the stage is resized', async () => {
    const { controller } = await setup();
    controller.setStage(1000, 800);
    controller.setView({ x: 0, y: 0, zoom: 1 });
    const centre = controller.viewCenter();
    controller.setStage(400, 800);
    expect(controller.viewCenter()).toEqual(centre);
  });
});
