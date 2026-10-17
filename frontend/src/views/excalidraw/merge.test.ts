import { describe, expect, it } from 'vitest';
import { el, markdownDrawing, scene, text } from '../../test/drawings';
import { markdownParts, parseDrawing, type Scene, type SceneElement } from './format';
import { deepEqual, mergeAppState, mergeDrawingTexts, mergeElements, unchanged } from './merge';

const json = (s: Scene) => JSON.stringify(s, null, 2);
const edit = (e: SceneElement, patch: Partial<SceneElement>, versionNonce = e.versionNonce + 1): SceneElement => ({ ...e, ...patch, version: e.version + 1, versionNonce });

function mergedScene(format: 'excalidraw' | 'markdown', base: string, mine: string, theirs: string): Scene {
  const out = mergeDrawingTexts(format, base, mine, theirs);
  if (out === null) throw new Error('merge gave up');
  const r = parseDrawing(format, out);
  if (!r.ok) throw new Error(r.message);
  return r.drawing.scene;
}

describe('element merge', () => {
  const a = el('a', { index: 'a0' });
  const b = el('b', { index: 'a1' });
  const c = el('c', { index: 'a2' });

  it('keeps additions from both sides', () => {
    const mine = [a, b, el('m', { index: 'a3' })];
    const theirs = [a, b, el('t', { index: 'a4' })];
    expect(mergeElements([a, b], mine, theirs).elements.map((e) => e.id)).toEqual(['a', 'b', 'm', 't']);
  });

  it('takes each side’s edits to different elements', () => {
    const merged = mergeElements([a, b], [edit(a, { x: 5 }), b], [a, edit(b, { y: 7 })]);
    expect(merged.elements.map((e) => [e.id, e.x, e.y])).toEqual([
      ['a', 5, 0],
      ['b', 0, 7],
    ]);
    expect([...merged.from]).toEqual([
      ['a', 'mine'],
      ['b', 'theirs'],
    ]);
  });

  it('settles an element both sides changed by version, then by versionNonce', () => {
    const mine = edit(edit(a, { x: 1 }), { x: 2 });
    const theirs = edit(a, { x: 3 });
    expect(mergeElements([a], [mine], [theirs]).elements[0].x).toBe(2);
    const tieMine = edit(a, { x: 1 }, 5);
    const tieTheirs = edit(a, { x: 9 }, 4);
    expect(mergeElements([a], [tieMine], [tieTheirs]).elements[0].x).toBe(9);
    expect(mergeElements([a], [tieTheirs], [tieMine]).elements[0].x).toBe(9);
  });

  it('applies a deletion the other side did not touch, but never drops an edit', () => {
    expect(mergeElements([a, b], [a, b], [a]).elements.map((e) => e.id)).toEqual(['a']);
    expect(mergeElements([a, b], [a], [a, b]).elements.map((e) => e.id)).toEqual(['a']);
    expect(mergeElements([a, b], [a, edit(b, { x: 4 })], [a]).elements.map((e) => e.id)).toEqual(['a', 'b']);
    // Tombstones (isDeleted) win by version like any edit, and are dropped from the file.
    expect(mergeElements([a, b], [a, edit(b, { isDeleted: true })], [a, b]).elements.map((e) => e.id)).toEqual(['a']);
  });

  it('does not count the index Excalidraw adds to an older file as an edit', () => {
    const old = el('a');
    delete old.index;
    const opened = { ...old, index: 'a0', version: old.version + 1, versionNonce: 1 };
    const theirs = { ...old, x: 42, version: old.version + 1, versionNonce: 999999 };
    expect(unchanged(opened, old)).toBe(true);
    expect(mergeElements([old], [opened], [theirs]).elements[0].x).toBe(42);
  });

  it('orders by fractional index when every element has one', () => {
    const top = el('top', { index: 'a5' });
    const mid = el('mid', { index: 'a0V' });
    expect(mergeElements([a, b, c], [a, b, c, top], [a, mid, b, c]).elements.map((e) => e.id)).toEqual(['a', 'mid', 'b', 'c', 'top']);
  });

  it('places elements only theirs has after their predecessor there', () => {
    const [x, y, z] = [el('x'), el('y'), el('z')].map((e) => ({ ...e, index: null }));
    const t1 = { ...el('t1'), index: null };
    const t0 = { ...el('t0'), index: null };
    expect(mergeElements([x, y, z], [x, y, z], [t0, x, y, t1, z]).elements.map((e) => e.id)).toEqual(['t0', 'x', 'y', 't1', 'z']);
  });

  it('merges appState per key', () => {
    expect(mergeAppState({ grid: 20, bg: '#fff' }, { grid: 10, bg: '#fff' }, { grid: 20, bg: '#000' })).toEqual({ grid: 10, bg: '#000' });
    expect(mergeAppState({ grid: 20 }, { grid: 20 }, {})).toEqual({});
  });

  it('compares JSON values deeply', () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(deepEqual([1, 2], { 0: 1, 1: 2 })).toBe(false);
  });
});

describe('merging .excalidraw files', () => {
  it('merges concurrent edits from two devices', () => {
    const r = el('r', { index: 'a0' });
    const t = text('t', 'Label', { index: 'a1' });
    const base = scene([r, t]);
    const mine = scene([edit(r, { backgroundColor: '#f00' }), t, el('m', { index: 'a2' })]);
    const theirs = scene([r, edit(t, { text: 'Renamed', originalText: 'Renamed' })], { appState: { gridSize: 20, viewBackgroundColor: '#eee' } });
    const out = mergedScene('excalidraw', json(base), json(mine), json(theirs));
    expect(out.elements.map((e) => e.id)).toEqual(['r', 't', 'm']);
    expect(out.elements[0].backgroundColor).toBe('#f00');
    expect(out.elements[1].text).toBe('Renamed');
    expect(out.appState.viewBackgroundColor).toBe('#eee');
  });

  it('keeps the files of surviving images from either side', () => {
    const base = scene([]);
    const mine = scene([el('img1', { type: 'image', fileId: 'f1' })], { files: { f1: { id: 'f1', mimeType: 'image/png', path: 'Attachments/one.png' } } });
    const theirs = scene([el('img2', { type: 'image', fileId: 'f2' })], { files: { f2: { id: 'f2', mimeType: 'image/png', path: 'Attachments/two.png' }, unused: { id: 'unused', mimeType: 'image/png', path: 'x.png' } } });
    const out = mergedScene('excalidraw', json(base), json(mine), json(theirs));
    expect(Object.keys(out.files).sort()).toEqual(['f1', 'f2']);
  });

  it('gives up on files it cannot read', () => {
    const ok = json(scene([]));
    expect(mergeDrawingTexts('excalidraw', ok, '{broken', ok)).toBeNull();
    expect(mergeDrawingTexts('excalidraw', ok, ok, '{"type":"other"}')).toBeNull();
  });
});

describe('merging .excalidraw.md files', () => {
  const t1 = text('Ab12Cd34', 'Hello World');
  const r = el('rect0001');
  const base = markdownDrawing({ texts: [['Ab12Cd34', 'Hello [[World]]']], scene: scene([t1, r]) });

  it('merges the drawings and keeps each text’s Markdown source', () => {
    const mine = markdownDrawing({ texts: [['Ab12Cd34', 'Hello [[World]]']], scene: scene([t1, edit(r, { x: 99 })]) });
    const theirs = markdownDrawing({
      texts: [
        ['Ab12Cd34', 'Hello [[World]]'],
        ['New12345', 'From the phone'],
      ],
      scene: scene([t1, r, text('New12345', 'From the phone')]),
    });
    const out = mergeDrawingTexts('markdown', base, mine, theirs)!;
    const parts = markdownParts(out);
    expect(parts.texts).toEqual([
      { id: 'Ab12Cd34', raw: 'Hello [[World]]' },
      { id: 'New12345', raw: 'From the phone' },
    ]);
    const s = mergedScene('markdown', base, mine, theirs);
    expect(s.elements.find((e) => e.id === 'rect0001')!.x).toBe(99);
  });

  it('keeps one side’s change to the Markdown around the drawing', () => {
    const mine = markdownDrawing({ texts: [['Ab12Cd34', 'Hello [[World]]']], scene: scene([t1, edit(r, { x: 1 })]) });
    const theirs = base.replace('tags: [excalidraw]', 'tags: [excalidraw, edited]');
    const out = mergeDrawingTexts('markdown', base, mine, theirs)!;
    expect(out).toContain('tags: [excalidraw, edited]');
    expect(mergedScene('markdown', base, mine, theirs).elements.find((e) => e.id === 'rect0001')!.x).toBe(1);
    // Both sides edited it the same way: fine too.
    expect(mergeDrawingTexts('markdown', base, theirs, theirs)).toContain('tags: [excalidraw, edited]');
  });

  it('gives up when both sides changed the Markdown around the drawing differently', () => {
    const mine = base.replace('tags: [excalidraw]', 'tags: [mine]');
    const theirs = base.replace('tags: [excalidraw]', 'tags: [theirs]');
    expect(mergeDrawingTexts('markdown', base, mine, theirs)).toBeNull();
  });

  it('keeps Embedded Files entries from both sides', () => {
    const img = (id: string, fileId: string) => el(id, { type: 'image', fileId });
    const mine = markdownDrawing({ texts: [['Ab12Cd34', 'Hello [[World]]']], embedded: [['f1', '[[one.png]]']], scene: scene([t1, r, img('i1', 'f1')]) });
    const theirs = markdownDrawing({ texts: [['Ab12Cd34', 'Hello [[World]]']], embedded: [['f2', '[[two.png]]']], scene: scene([t1, r, img('i2', 'f2')]) });
    const out = mergeDrawingTexts('markdown', base, mine, theirs)!;
    expect(markdownParts(out).embedded.map((e) => e.id).sort()).toEqual(['f1', 'f2']);
    expect(mergedScene('markdown', base, mine, theirs).elements.map((e) => e.id)).toEqual(['Ab12Cd34', 'rect0001', 'i1', 'i2']);
  });
});
