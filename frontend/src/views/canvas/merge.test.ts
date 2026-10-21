import { describe, expect, it } from 'vitest';
import { OBSIDIAN_SAMPLE } from './fixtures.test-data';
import { parseCanvas, serializeCanvas } from './format';
import { mergeCanvas } from './merge';
import type { CanvasDoc } from './model';
import { addEdges, addNodes, deleteItems, moveNodes, reorder, updateEdge, updateNode } from './ops';

const base = OBSIDIAN_SAMPLE;
const doc = () => parseCanvas(base);
const write = (d: CanvasDoc) => serializeCanvas(d);
const TEXT = '59e896bc8da20699';
const PLAN = '8132d4d894c80022';
const LINK = '0ba565e7f30e0652';

function merged(mine: string, theirs: string): CanvasDoc {
  const out = mergeCanvas(base, mine, theirs);
  expect(out).not.toBeNull();
  return parseCanvas(out!);
}

describe('mergeCanvas', () => {
  it('returns the other side when one side did not change', () => {
    const theirs = write(moveNodes(doc(), new Set([PLAN]), 10, 0));
    expect(mergeCanvas(base, base, theirs)).toBe(theirs);
    expect(mergeCanvas(base, theirs, base)).toBe(theirs);
    expect(mergeCanvas(base, theirs, theirs)).toBe(theirs);
  });

  it('combines edits to different nodes', () => {
    const mine = write(updateNode(doc(), TEXT, { text: 'Mine' }));
    const theirs = write(moveNodes(doc(), new Set([PLAN]), 100, 50));
    const m = merged(mine, theirs);
    expect(m.nodes.find((n) => n.id === TEXT)!.text).toBe('Mine');
    expect(m.nodes.find((n) => n.id === PLAN)).toMatchObject({ x: -180, y: -150 });
  });

  it('combines edits to different fields of one node', () => {
    const mine = write(updateNode(doc(), TEXT, { text: 'Mine' }));
    const theirs = write(updateNode(moveNodes(doc(), new Set([TEXT]), 0, 30), TEXT, { color: '4' }));
    const node = merged(mine, theirs).nodes.find((n) => n.id === TEXT)!;
    expect(node).toMatchObject({ text: 'Mine', y: -410, color: '4', styleAttributes: { border: 'dashed' } });
  });

  it('prefers this device for conflicting moves, but refuses conflicting text', () => {
    const mineMove = write(moveNodes(doc(), new Set([TEXT]), 10, 0));
    const theirsMove = write(moveNodes(doc(), new Set([TEXT]), 99, 5));
    expect(merged(mineMove, theirsMove).nodes.find((n) => n.id === TEXT)).toMatchObject({ x: 50, y: -435 });
    const mineText = write(updateNode(doc(), TEXT, { text: 'A' }));
    const theirsText = write(updateNode(doc(), TEXT, { text: 'B' }));
    expect(mergeCanvas(base, mineText, theirsText)).toBeNull();
  });

  it('keeps nodes added on both sides, each after its neighbour', () => {
    const a = { id: 'aaaaaaaaaaaaaaaa', type: 'text', text: 'mine', x: 0, y: 0, width: 10, height: 10 };
    const b = { id: 'bbbbbbbbbbbbbbbb', type: 'text', text: 'theirs', x: 0, y: 0, width: 10, height: 10 };
    const m = merged(write(addNodes(doc(), [a])), write(addNodes(doc(), [b])));
    expect(m.nodes.map((n) => n.id).slice(-2).sort()).toEqual([a.id, b.id]);
    expect(m.nodes).toHaveLength(7);
  });

  it('deletes what one side deleted and the other left alone, keeping edited ones', () => {
    const mine = write(deleteItems(doc(), new Set([LINK]), new Set()));
    const theirs = write(updateNode(doc(), PLAN, { color: '1' }));
    const m = merged(mine, theirs);
    expect(m.nodes.some((n) => n.id === LINK)).toBe(false);
    expect(m.edges.map((e) => e.toNode)).not.toContain(LINK);
    const theirsEdited = write(updateNode(doc(), LINK, { url: 'https://example.org' }));
    expect(merged(mine, theirsEdited).nodes.find((n) => n.id === LINK)!.url).toBe('https://example.org');
  });

  it('drops edges whose node the other side deleted', () => {
    const edge = { id: 'eeeeeeeeeeeeeeee', fromNode: PLAN, toNode: LINK };
    const mine = write(addEdges(doc(), [edge]));
    const theirs = write(deleteItems(doc(), new Set([LINK]), new Set()));
    const m = merged(mine, theirs);
    expect(m.edges.find((e) => e.id === edge.id)).toBeUndefined();
  });

  it('merges edge edits and stacking order', () => {
    const mine = write(updateEdge(doc(), '6fa11ab87f90b8af', { label: 'mine' }));
    const theirs = write(reorder(doc(), new Set([PLAN]), 'front'));
    const m = merged(mine, theirs);
    expect(m.edges[0].label).toBe('mine');
    expect(m.edges[0].styleAttributes).toEqual({ pathfindingMethod: 'square' });
    expect(m.nodes[m.nodes.length - 1].id).toBe(PLAN);
  });

  it('keeps the untouched lines of the file as they were', () => {
    const mine = write(updateNode(doc(), PLAN, { color: '3' }));
    const theirs = write(updateNode(doc(), LINK, { color: '5' }));
    const out = mergeCanvas(base, mine, theirs)!;
    const lines = out.split('\n');
    expect(lines[5]).toBe(base.split('\n')[5]);
    expect(out).toContain('\\u2014 caf\\u00e9');
  });

  it('fails on files it cannot read', () => {
    expect(mergeCanvas(base, '{oops', base.replace('Project board', 'Board'))).toBeNull();
  });

  it('refuses to choose between conflicting unknown top-level data', () => {
    const mine = base.replace('"version":"1.0-1.0"', '"version":"2"');
    const theirs = base.replace('"version":"1.0-1.0"', '"version":"3"');
    expect(mergeCanvas(base, mine, theirs)).toBeNull();
  });
});
