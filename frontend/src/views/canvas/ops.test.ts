import { describe, expect, it } from 'vitest';
import { parseCanvas } from './format';
import { edgeGeometry, nodeRect, sideToward, type CanvasDoc, type CanvasNode } from './model';
import { copyFragment, deleteItems, groupNodes, moveNodes, parseFragment, pasteFragment, reorder, withGroupContents } from './ops';

const node = (id: string, x: number, y: number, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, type: 'text', text: id, x, y, width: 100, height: 50, ...extra });

function docOf(nodes: CanvasNode[], edges: CanvasDoc['edges'] = []): CanvasDoc {
  return parseCanvas(JSON.stringify({ nodes, edges }));
}

describe('canvas operations', () => {
  it('moves with whole-pixel positions and keeps untouched nodes', () => {
    const doc = docOf([node('a', 0, 0), node('b', 200, 0)]);
    const next = moveNodes(doc, new Set(['a']), 10.4, -3.6);
    expect(next.nodes[0]).toMatchObject({ x: 10, y: -4 });
    expect(next.nodes[1]).toBe(doc.nodes[1]);
    expect(moveNodes(doc, new Set(['a']), 0, 0)).toBe(doc);
  });

  it('carries the nodes inside a moved group', () => {
    const doc = docOf([node('g', 0, 0, { type: 'group', width: 500, height: 500 }), node('in', 50, 50), node('out', 600, 0)]);
    expect([...withGroupContents(doc, new Set(['g']))].sort()).toEqual(['g', 'in']);
  });

  it('deletes nodes with their edges', () => {
    const doc = docOf([node('a', 0, 0), node('b', 200, 0), node('c', 400, 0)], [
      { id: 'ab', fromNode: 'a', toNode: 'b' },
      { id: 'bc', fromNode: 'b', toNode: 'c' },
    ]);
    const next = deleteItems(doc, new Set(['a']), new Set());
    expect(next.nodes.map((n) => n.id)).toEqual(['b', 'c']);
    expect(next.edges.map((e) => e.id)).toEqual(['bc']);
    expect(deleteItems(doc, new Set(), new Set(['bc'])).edges.map((e) => e.id)).toEqual(['ab']);
  });

  it('groups beneath the lowest member', () => {
    const doc = docOf([node('x', 900, 900), node('a', 0, 0), node('b', 200, 100)]);
    const { doc: next, id } = groupNodes(doc, new Set(['a', 'b']), 'Mine')!;
    expect(next.nodes.map((n) => n.id)).toEqual(['x', id, 'a', 'b']);
    expect(nodeRect(next.nodes[1])).toEqual({ x: -40, y: -40, width: 380, height: 230 });
    expect(next.nodes[1].label).toBe('Mine');
  });

  it('copies and pastes with fresh ids and remapped edges', () => {
    const doc = docOf([node('a', 0, 0), node('b', 200, 0), node('c', 400, 0)], [
      { id: 'ab', fromNode: 'a', toNode: 'b', label: 'x' },
      { id: 'bc', fromNode: 'b', toNode: 'c' },
    ]);
    const fragment = copyFragment(doc, new Set(['a', 'b']));
    expect(fragment.edges.map((e) => e.id)).toEqual(['ab']);
    const clip = parseFragment(JSON.stringify(fragment));
    expect(clip).not.toBeNull();
    const { doc: next, ids } = pasteFragment(doc, clip!, { x: 1000, y: 500 });
    expect(ids).toHaveLength(2);
    expect(next.nodes).toHaveLength(5);
    const pasted = next.nodes.filter((n) => ids.includes(n.id));
    expect(pasted.map((n) => [n.x, n.y])).toEqual([
      [1000, 500],
      [1200, 500],
    ]);
    const edge = next.edges[next.edges.length - 1];
    expect(edge).toMatchObject({ label: 'x', fromNode: ids[0], toNode: ids[1] });
    expect(parseFragment('just text')).toBeNull();
  });

  it('reorders to front and back', () => {
    const doc = docOf([node('a', 0, 0), node('b', 0, 0), node('c', 0, 0)]);
    expect(reorder(doc, new Set(['a']), 'front').nodes.map((n) => n.id)).toEqual(['b', 'c', 'a']);
    expect(reorder(doc, new Set(['c']), 'back').nodes.map((n) => n.id)).toEqual(['c', 'a', 'b']);
    expect(reorder(doc, new Set(['c']), 'front')).toBe(doc);
  });
});

describe('geometry', () => {
  it('picks the facing side', () => {
    const r = { x: 0, y: 0, width: 200, height: 100 };
    expect(sideToward(r, { x: 500, y: 50 })).toBe('right');
    expect(sideToward(r, { x: 100, y: -300 })).toBe('top');
    expect(sideToward(r, { x: -10, y: 60 })).toBe('left');
  });

  it('draws edges from side to side', () => {
    const g = edgeGeometry({ x: 0, y: 0, width: 100, height: 100 }, 'right', { x: 300, y: 0, width: 100, height: 100 }, 'left');
    expect(g.start).toEqual({ x: 100, y: 50 });
    expect(g.end).toEqual({ x: 300, y: 50 });
    expect(g.mid).toEqual({ x: 200, y: 50 });
    expect(g.d.startsWith('M100,50 C')).toBe(true);
  });
});
