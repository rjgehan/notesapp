import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockVault } from '../../api/mock/vault';
import type { SaveFileRequest } from '../../api/types';
import { el, markdownDrawing, scene, text } from '../../test/drawings';
import { fakeApi, sessionDeps } from '../../test/fakes';
import { DocumentSession } from '../../sync/DocumentSession';
import { DrawingController, type AppStateLike, type DrawingEnv, type SceneApi, type SceneLib } from './controller';
import type { LiveFile } from './files';
import { drawingFormat, markdownParts, markdownRest, parseDrawing, type Scene, type SceneElement } from './format';
import { mergeDrawingTexts } from './merge';

// ---------- a stand-in for Excalidraw ----------

const fakeLib: SceneLib = {
  // Like Excalidraw's restore: copies, and an incoming element older than the local one is bumped past it.
  restoreElements: (elements, local) =>
    elements.map((e) => {
      const mine = local?.find((l) => l.id === e.id);
      return mine && mine.version > e.version ? { ...e, version: mine.version + 1 } : { ...e };
    }),
  hashElementsVersion: (elements) => elements.reduce((h, e) => (Math.imul(h ^ e.version, 31) + e.id.length) | 0, 7),
  captureNever: 'NEVER',
};

/** Holds a scene, reports every change through onChange like Excalidraw, and lets tests "draw". */
class FakeExcalidraw implements SceneApi {
  elements: SceneElement[];
  appState: AppStateLike;
  files: Record<string, LiveFile>;
  updates: Array<{ elements?: readonly SceneElement[]; captureUpdate?: unknown }> = [];
  private readonly controller: DrawingController;

  constructor(controller: DrawingController) {
    this.controller = controller;
    const state = controller.getState();
    if (!state.initial) throw new Error('not a drawing');
    this.elements = fakeLib.restoreElements(state.initial.elements, null);
    this.appState = { ...state.initial.appState };
    this.files = Object.fromEntries(state.initial.files.map((f) => [f.id, f]));
    controller.attach(this);
    this.report();
  }

  report(): void {
    this.controller.onChange(this.elements, this.appState, this.files);
  }

  getSceneElementsIncludingDeleted() {
    return this.elements;
  }
  getAppState() {
    return this.appState;
  }
  getFiles() {
    return this.files;
  }
  updateScene(s: { elements?: readonly SceneElement[]; appState?: Record<string, unknown>; captureUpdate?: unknown }) {
    this.updates.push(s);
    if (s.elements) this.elements = [...s.elements];
    if (s.appState) this.appState = { ...this.appState, ...s.appState };
    this.report();
  }
  addFiles(files: LiveFile[]) {
    this.files = { ...this.files, ...Object.fromEntries(files.map((f) => [f.id, f])) };
    this.report();
  }

  // ---------- the user's edits ----------
  add(e: SceneElement): void {
    this.elements = [...this.elements, e];
    this.report();
  }
  /** Excalidraw mutates elements in place and bumps their version. */
  change(id: string, patch: Partial<SceneElement>): void {
    const e = this.elements.find((x) => x.id === id)!;
    Object.assign(e, patch, { version: e.version + 1, versionNonce: Math.floor(Math.random() * 1e9) });
    this.report();
  }
  ids(): string[] {
    return this.elements.filter((e) => !e.isDeleted).map((e) => e.id);
  }
}

function fakeEnv(overrides: Partial<DrawingEnv> = {}): DrawingEnv & { uploads: Array<{ name: string | null; source: string; size: number }>; errors: string[] } {
  const uploads: Array<{ name: string | null; source: string; size: number }> = [];
  const errors: string[] = [];
  let n = 0;
  return {
    uploads,
    errors,
    loadAttachment: vi.fn(async (path: string) => ({ dataURL: `data:image/png;base64,${btoa(path)}`, mimeType: 'image/png', path })),
    resolveLink: vi.fn((target: string) => (target.endsWith('.png') ? `Attachments/${target}` : null)),
    upload: vi.fn(async (blob: Blob, name: string | null, source: string) => {
      uploads.push({ name, source, size: blob.size });
      return { path: `Attachments/Pasted image ${++n}.png` };
    }),
    linkText: (path: string) => path.slice(path.lastIndexOf('/') + 1),
    reportError: (m: string) => errors.push(m),
    ...overrides,
  };
}

async function setup(path: string, content: string, envOverrides: Partial<DrawingEnv> = {}) {
  const vault = new MockVault(false);
  vault.createFile({ path, content }, 'other-device-1');
  const fake = fakeApi(vault);
  const format = drawingFormat(path);
  const deps = sessionDeps(fake.api, { mergeFor: () => (b, m, t) => mergeDrawingTexts(format, b, m, t) });
  const session = new DocumentSession(path, deps);
  await session.ready;
  const env = fakeEnv(envOverrides);
  const controller = new DrawingController(session, format, fakeLib, env);
  // As the view does: text the session puts into its buffer reaches the scene at once.
  session.subscribe(() => controller.sync());
  const canvas = new FakeExcalidraw(controller);
  await vi.advanceTimersByTimeAsync(0);
  const saved = () => {
    const r = parseDrawing(format, vault.readFile(path).content);
    if (!r.ok) throw new Error(r.message);
    return r.drawing;
  };
  /** Another device saves `next(current file)`, and the event reaches this tab. */
  const remote = async (next: ((current: Scene) => Scene) | string) => {
    const out = typeof next === 'string' ? next : next(saved().scene);
    vault.externalWrite(path, typeof out === 'string' ? out : JSON.stringify(out, null, 2));
    await session.onRemoteChanged({ version: vault.readFile(path).version });
    await vi.advanceTimersByTimeAsync(0);
  };
  return { vault, fake, deps, session, controller, canvas, env, saved, remote };
}

const json = (s: Scene) => JSON.stringify(s, null, 2);
const status = (s: DocumentSession) => s.getSnapshot().status;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('saving a drawing', () => {
  it('marks the session dirty only when the drawing changes, and saves the scene lazily', async () => {
    const { session, canvas, fake, saved } = await setup('Plan.excalidraw', json(scene([el('a')])));
    expect(status(session)).toBe('clean');
    // Scrolling, zooming and selecting are not edits.
    canvas.appState = { ...canvas.appState, scrollX: 120, zoom: { value: 2 }, selectedElementIds: { a: true } };
    canvas.report();
    expect(status(session)).toBe('clean');

    canvas.add(el('b'));
    expect(status(session)).toBe('dirty');
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.api.saveFile).toHaveBeenCalledTimes(1);
    expect(status(session)).toBe('clean');
    expect(saved().scene.elements.map((e) => e.id)).toEqual(['a', 'b']);
    // Excalidraw's file format: the scene appState keys, no scroll position.
    expect(saved().scene.appState).toEqual({ gridSize: 20, viewBackgroundColor: '#ffffff' });

    canvas.appState = { ...canvas.appState, viewBackgroundColor: '#ffeeee' };
    canvas.report();
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved().scene.appState.viewBackgroundColor).toBe('#ffeeee');
  });

  it('serializes only when the session saves, not on every pointer move', async () => {
    const { canvas, controller } = await setup('Plan.excalidraw', json(scene([el('a')])));
    const serialize = vi.spyOn(controller, 'serialize');
    canvas.add(el('b'));
    for (let i = 0; i < 50; i++) canvas.change('b', { x: i });
    expect(serialize).not.toHaveBeenCalled();
  });

  it('drops deleted elements and image placeholders still waiting for their upload', async () => {
    const { canvas, saved } = await setup('Plan.excalidraw', json(scene([el('a'), el('b')])));
    canvas.change('b', { isDeleted: true });
    canvas.add(el('img', { type: 'image', fileId: null, status: 'pending' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved().scene.elements.map((e) => e.id)).toEqual(['a']);
  });

  it('still saves the last edits after the view unmounted (Excalidraw tore its scene down)', async () => {
    const { session, canvas, controller, saved } = await setup('Plan.excalidraw', json(scene([el('a')])));
    canvas.add(el('b'));
    controller.attach(null);
    canvas.elements = [];
    await session.flush();
    expect(saved().scene.elements.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('a view mounted again starts from the unsaved edits of the earlier one', async () => {
    const { session, canvas, controller, env } = await setup('Plan.excalidraw', json(scene([el('a')])));
    canvas.add(el('b'));
    controller.attach(null);
    const again = new DrawingController(session, 'excalidraw', fakeLib, env);
    expect(again.getState().initial!.elements.map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('remote changes', () => {
  it('applies a remote change to a clean drawing without saving it back', async () => {
    const { session, canvas, fake, remote } = await setup('Plan.excalidraw', json(scene([el('a')])));
    await remote((s) => ({ ...s, elements: [...s.elements, el('theirs')] }));
    expect(canvas.ids()).toEqual(['a', 'theirs']);
    expect(canvas.updates.at(-1)!.captureUpdate).toBe('NEVER');
    expect(status(session)).toBe('clean');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.api.saveFile).not.toHaveBeenCalled();
    // The applied scene is the saved state: the next report is not an edit.
    canvas.report();
    expect(status(session)).toBe('clean');
  });

  it('merges a remote change into unsaved edits, live, without the banner', async () => {
    const { session, canvas, deps, saved, remote } = await setup('Plan.excalidraw', json(scene([el('a'), el('b')])));
    canvas.add(el('mine'));
    canvas.change('a', { x: 40 });
    await remote((s) => ({ ...s, elements: [...s.elements.filter((e) => e.id !== 'b'), el('theirs')] }));
    expect(session.getSnapshot().conflict).toBeNull();
    expect(canvas.ids().sort()).toEqual(['a', 'mine', 'theirs']);
    expect(deps.notices).toContain('Merged changes from another device');
    await vi.advanceTimersByTimeAsync(1000);
    expect(status(session)).toBe('clean');
    const file = saved().scene;
    expect(file.elements.map((e) => e.id).sort()).toEqual(['a', 'mine', 'theirs']);
    expect(file.elements.find((e) => e.id === 'a')!.x).toBe(40);
  });

  it('merges when a save meets a newer version (409)', async () => {
    const { vault, session, canvas, fake, saved } = await setup('Plan.excalidraw', json(scene([el('a')])));
    vault.externalWrite('Plan.excalidraw', json(scene([el('a'), el('theirs')])));
    canvas.add(el('mine'));
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(status(session)).toBe('clean');
    expect(saved().scene.elements.map((e) => e.id).sort()).toEqual(['a', 'mine', 'theirs']);
    // The merged save preserved theirs in history first.
    expect((fake.api.saveFile.mock.calls.at(-1)![1] as SaveFileRequest).flushHistory).toBe(true);
    expect(canvas.ids().sort()).toEqual(['a', 'mine', 'theirs']);
  });

  it('keeps the element the user is drawing while a remote change lands', async () => {
    const { canvas, remote } = await setup('Plan.excalidraw', json(scene([el('a')])));
    const drawing = el('pen', { type: 'freedraw', points: [[0, 0]] });
    canvas.add(drawing);
    canvas.appState = { ...canvas.appState, newElement: { id: 'pen' } };
    await remote((s) => ({ ...s, elements: [...s.elements, el('theirs')] }));
    expect(canvas.elements.find((e) => e.id === 'pen')).toBe(drawing);
    expect(canvas.ids().sort()).toEqual(['a', 'pen', 'theirs']);
  });

  it('raises the banner for a version it cannot merge, and merges a later one', async () => {
    const { session, canvas, saved, remote } = await setup('Plan.excalidraw', json(scene([el('a')])));
    canvas.add(el('mine'));
    // Their file cannot be merged (it is broken JSON): the banner appears, the canvas keeps mine.
    await remote('{broken');
    expect(status(session)).toBe('conflict');
    expect(canvas.ids()).toEqual(['a', 'mine']);
    await remote(json(scene([el('a'), el('theirs')])));
    expect(session.getSnapshot().conflict).toBeNull();
    expect(canvas.ids().sort()).toEqual(['a', 'mine', 'theirs']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved().scene.elements.map((e) => e.id).sort()).toEqual(['a', 'mine', 'theirs']);
  });

  it('Take theirs puts their version on the canvas; an unreadable one opens as text', async () => {
    const { session, canvas, controller, remote } = await setup('Plan.excalidraw', json(scene([el('a')])));
    canvas.add(el('mine'));
    await remote('{broken');
    await session.takeTheirs();
    expect(status(session)).toBe('clean');
    expect(controller.getState().mode).toMatchObject({ kind: 'fallback', reason: 'malformed' });
    expect(session.getText()).toBe('{broken');
  });
});

describe('Obsidian Excalidraw (.excalidraw.md)', () => {
  const path = 'Drawings/Map.excalidraw.md';
  const file = markdownDrawing({
    texts: [['Ab12Cd34', 'Hello [[World]]']],
    embedded: [['f1', '[[pic.png]]']],
    scene: scene([text('Ab12Cd34', 'Hello World'), el('rect0001'), el('img00001', { type: 'image', fileId: 'f1' })]),
    tail: '\n',
  });

  it('rewrites only the drawing block and the text elements, with 8-character ids for new texts', async () => {
    const { canvas, saved, vault } = await setup(path, file);
    canvas.add(text('Kx3yG7mZ-wq_9pLrT2vNc', 'New label'));
    await vi.advanceTimersByTimeAsync(1000);
    const out = vault.readFile(path).content;
    const parts = markdownParts(out);
    expect(markdownRest(parts)).toBe(markdownRest(markdownParts(file)));
    expect(out.slice(parts.embeddedSection!.from, parts.embeddedSection!.to)).toBe('f1: [[pic.png]]\n\n');
    expect(parts.texts[0]).toEqual({ id: 'Ab12Cd34', raw: 'Hello [[World]]' });
    const added = parts.texts[1];
    expect(added.raw).toBe('New label');
    expect(added.id).toMatch(/^[0-9A-Za-z]{8}$/);
    expect(saved().scene.elements.map((e) => e.id)).toEqual(['Ab12Cd34', 'rect0001', 'img00001', added.id]);
    // The scene keeps Excalidraw's own id (undo history and selection stay valid).
    expect(canvas.ids()).toContain('Kx3yG7mZ-wq_9pLrT2vNc');
  });

  it('maps remote text back to the scene’s ids, so nothing is duplicated', async () => {
    const { canvas, vault, session } = await setup(path, file);
    canvas.add(text('Kx3yG7mZ-wq_9pLrT2vNc', 'New label'));
    await vi.advanceTimersByTimeAsync(1000);
    const out = vault.readFile(path).content;
    vault.externalWrite(path, out.replace('"x": 0,', '"x": 77,'));
    await session.onRemoteChanged({ version: vault.readFile(path).version });
    expect(canvas.ids().filter((id) => id !== 'rect0001' && id !== 'img00001' && id !== 'Ab12Cd34')).toEqual(['Kx3yG7mZ-wq_9pLrT2vNc']);
  });

  it('an edited text replaces its Markdown source; untouched ones keep theirs', async () => {
    const { canvas, vault } = await setup(path, file);
    canvas.change('rect0001', { x: 5 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(markdownParts(vault.readFile(path).content).texts).toEqual([{ id: 'Ab12Cd34', raw: 'Hello [[World]]' }]);
    canvas.change('Ab12Cd34', { text: 'Goodbye', originalText: 'Goodbye' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(markdownParts(vault.readFile(path).content).texts).toEqual([{ id: 'Ab12Cd34', raw: 'Goodbye' }]);
  });

  it('shows Embedded Files images through the vault, and Obsidian-only extras as static placeholders', async () => {
    const extras = markdownDrawing({
      embedded: [
        ['f1', '[[pic.png]]'],
        ['f2', '$$e=mc^2$$'],
        ['f3', '[[Missing note]]'],
      ],
      scene: scene(['f1', 'f2', 'f3'].map((f, i) => el(`img${i}`, { type: 'image', fileId: f }))),
    });
    const { canvas, env, vault } = await setup(path, extras);
    await vi.advanceTimersByTimeAsync(0);
    expect(env.loadAttachment).toHaveBeenCalledWith('Attachments/pic.png', path);
    expect(canvas.files.f1.dataURL).toMatch(/^data:image\/png;base64,/);
    expect(canvas.files.f2.dataURL).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(canvas.files.f3.dataURL).toMatch(/^data:image\/svg\+xml;base64,/);
    canvas.change('img0', { x: 9 });
    await vi.advanceTimersByTimeAsync(1000);
    // Nothing loaded for display is written into the file.
    const out = vault.readFile(path).content;
    expect(out).not.toContain('data:image');
    expect(parseDrawing('markdown', out)).toMatchObject({ ok: true, drawing: { scene: { files: {} } } });
  });
});

describe('images', () => {
  const png = (bytes: number, seed: number) => {
    const data = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i += 4096) data[i] = (seed + i) & 0xff;
    return new File([data], 'image.png', { type: 'image/png' });
  };

  it('uploads an image as an attachment of the drawing before Excalidraw places it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { session, canvas, controller, env, saved } = await setup('Plan.excalidraw', json(scene([])), {
      upload: vi.fn(async (_blob: Blob, _name: string | null, source: string) => {
        await gate;
        return { path: `Attachments/for ${source}.png` };
      }),
    });
    const pending = controller.generateIdForFile(png(1000, 1));
    // The upload counts as unsaved work (beforeunload, the new-build reload).
    await vi.waitFor(() => expect(session.uploadsInFlight).toBe(1));
    release();
    const id = await pending;
    expect(id).toMatch(/^[0-9a-f]{40}$/);
    expect(env.upload).toHaveBeenCalledWith(expect.any(File), 'image.png', 'Plan.excalidraw');
    expect(session.uploadsInFlight).toBe(0);
    // Excalidraw then adds the file (a data URL in memory) and the element.
    canvas.addFiles([{ id, mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA', created: 1 }]);
    canvas.add(el('img', { type: 'image', fileId: id, status: 'saved' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(saved().scene.files[id]).toEqual({ mimeType: 'image/png', id, created: expect.any(Number), path: 'Attachments/for Plan.excalidraw.png' });
    // The same image again is not uploaded twice.
    expect(await controller.generateIdForFile(png(1000, 1))).toBe(id);
    expect(env.upload).toHaveBeenCalledTimes(1);
  });

  it('reports a failed upload to Excalidraw, which then drops the image', async () => {
    const { controller } = await setup('Plan.excalidraw', json(scene([])), {
      upload: vi.fn(async () => {
        throw new Error('Offline');
      }),
    });
    await expect(controller.generateIdForFile(png(10, 2))).rejects.toThrow('The image could not be uploaded: Offline');
  });

  it('five 3 MB photos keep the drawing under 1 MB of JSON', async () => {
    const { canvas, controller, vault } = await setup('Trip.excalidraw', json(scene([])));
    for (let i = 0; i < 5; i++) {
      const photo = png(3 * 1024 * 1024, i);
      const id = await controller.generateIdForFile(photo);
      // What Excalidraw keeps in memory: the whole photo as a data URL.
      canvas.addFiles([{ id, mimeType: 'image/jpeg', dataURL: 'data:image/jpeg;base64,' + 'A'.repeat(4 * 1024 * 1024), created: i }]);
      canvas.add(el(`photo${i}`, { type: 'image', fileId: id, status: 'saved', width: 4000, height: 3000 }));
    }
    await vi.advanceTimersByTimeAsync(1000);
    const content = vault.readFile('Trip.excalidraw').content;
    expect(new TextEncoder().encode(content).length).toBeLessThan(1024 * 1024);
    expect(content).not.toContain('data:image');
    const files = (parseDrawing('excalidraw', content) as { ok: true; drawing: { scene: Scene } }).drawing.scene.files;
    expect(Object.values(files).map((f) => f.path)).toHaveLength(5);
  });

  it('shows the plugin’s extras as static images sized like their element, and keeps their entries', async () => {
    const path = 'Map.excalidraw.md';
    const content = markdownDrawing({
      embedded: [
        ['n1', '[[Plan#Goals]]'],
        ['t1', '$$e=mc^2$$'],
      ],
      scene: scene([el('note', { type: 'image', fileId: 'n1', width: 300, height: 200 }), el('tex', { type: 'image', fileId: 't1', width: 240, height: 60 })]),
    });
    const embeddedFile = vi.fn(async () => ({ dataURL: 'data:image/svg+xml;base64,PHN2Zy8+', mimeType: 'image/svg+xml' }));
    const { canvas, vault } = await setup(path, content, { resolveLink: vi.fn((t: string) => (t === 'Plan' ? 'Notes/Plan.md' : null)), embeddedFile });
    await vi.advanceTimersByTimeAsync(0);
    expect(embeddedFile).toHaveBeenCalledWith('Notes/Plan.md', 'Goals', path, { width: 300, height: 200 });
    expect(canvas.files.n1.dataURL).toBe('data:image/svg+xml;base64,PHN2Zy8+');
    expect(atob(canvas.files.t1.dataURL!.split(',')[1])).toContain('e=mc^2');
    // Showing them is not an edit, and a save keeps their entries.
    expect(vault.readFile(path).content).toBe(content);
    canvas.change('note', { x: 9 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(markdownParts(vault.readFile(path).content).embedded.map((e) => e.value)).toEqual(['[[Plan#Goals]]', '$$e=mc^2$$']);
  });

  it('lists an image added to an Obsidian drawing under Embedded Files, not in the JSON', async () => {
    const path = 'Map.excalidraw.md';
    const { canvas, controller, vault } = await setup(path, markdownDrawing({ scene: scene([]) }));
    const id = await controller.generateIdForFile(png(100, 3));
    canvas.addFiles([{ id, mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA', created: 1 }]);
    canvas.add(el('img', { type: 'image', fileId: id }));
    await vi.advanceTimersByTimeAsync(1000);
    const out = vault.readFile(path).content;
    expect(markdownParts(out).embedded).toEqual([{ id, value: '[[Pasted image 1.png]]', ref: { kind: 'link', target: 'Pasted image 1.png' } }]);
    expect((parseDrawing('markdown', out) as { ok: true; drawing: { scene: Scene } }).drawing.scene.files).toEqual({});
  });

  it('loads attachments for display and writes back only their paths', async () => {
    const files = { f1: { id: 'f1', mimeType: 'image/png', created: 5, path: 'Attachments/one.png' } };
    const { canvas, env, vault } = await setup('Plan.excalidraw', json(scene([el('i', { type: 'image', fileId: 'f1' })], { files })));
    expect(env.loadAttachment).toHaveBeenCalledWith('Attachments/one.png', 'Plan.excalidraw');
    expect(canvas.files.f1).toMatchObject({ dataURL: expect.stringMatching(/^data:image\/png/), path: 'Attachments/one.png' });
    canvas.change('i', { x: 3 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.parse(vault.readFile('Plan.excalidraw').content).files).toEqual(files);
  });

  it('shows a missing attachment as a placeholder and keeps its reference', async () => {
    const files = { f1: { id: 'f1', mimeType: 'image/png', created: 5, path: 'Attachments/gone.png' } };
    const { canvas, vault } = await setup('Plan.excalidraw', json(scene([el('i', { type: 'image', fileId: 'f1' })], { files })), { loadAttachment: vi.fn(async () => null) });
    expect(canvas.files.f1.dataURL).toMatch(/^data:image\/svg\+xml/);
    canvas.change('i', { x: 3 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.parse(vault.readFile('Plan.excalidraw').content).files).toEqual(files);
  });

  it('keeps small embedded images from excalidraw.com, and moves a large pasted one to an attachment', async () => {
    const small = { id: 'small', mimeType: 'image/png', created: 1, dataURL: 'data:image/png;base64,iVBORw0KGgo=' };
    const { canvas, env, vault } = await setup('Plan.excalidraw', json(scene([el('s', { type: 'image', fileId: 'small' })], { files: { small } })));
    expect(canvas.files.small.dataURL).toBe(small.dataURL);
    const big: LiveFile = { id: 'big', mimeType: 'image/png', created: 2, dataURL: 'data:image/png;base64,' + 'A'.repeat(300 * 1024) };
    canvas.addFiles([big]);
    canvas.add(el('b', { type: 'image', fileId: 'big' }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(env.upload).toHaveBeenCalledTimes(1);
    const content = JSON.parse(vault.readFile('Plan.excalidraw').content) as Scene;
    expect(content.files.small).toEqual(small);
    expect(content.files.big).toEqual({ mimeType: 'image/png', id: 'big', created: 2, path: 'Attachments/Pasted image 1.png' });
  });
});

describe('files that are not readable drawings', () => {
  it('falls back to the text view, and back to the drawing once the file is readable again', async () => {
    const vault = new MockVault(false);
    vault.createFile({ path: 'Bad.excalidraw', content: '{"elements": [' }, 'other');
    const session = new DocumentSession('Bad.excalidraw', sessionDeps(fakeApi(vault).api));
    await session.ready;
    const controller = new DrawingController(session, 'excalidraw', fakeLib, fakeEnv());
    session.subscribe(() => controller.sync());
    expect(controller.getState()).toMatchObject({ generation: 0, mode: { kind: 'fallback', reason: 'malformed' }, initial: null });
    vault.externalWrite('Bad.excalidraw', json(scene([el('a')])));
    await session.onRemoteChanged({ version: vault.readFile('Bad.excalidraw').version });
    expect(controller.getState()).toMatchObject({ generation: 1, mode: { kind: 'drawing' } });
    expect(controller.getState().initial!.elements.map((e) => e.id)).toEqual(['a']);
  });

  it('an .excalidraw.md without a drawing is a note', async () => {
    const vault = new MockVault(false);
    vault.createFile({ path: 'Note.excalidraw.md', content: '# Not a drawing\n' }, 'other');
    const session = new DocumentSession('Note.excalidraw.md', sessionDeps(fakeApi(vault).api));
    await session.ready;
    const controller = new DrawingController(session, 'markdown', fakeLib, fakeEnv());
    expect(controller.getState().mode).toMatchObject({ kind: 'fallback', reason: 'not-a-drawing' });
  });
});
