import { describe, expect, it } from 'vitest';
import { COMPACT_SAMPLE, OBSIDIAN_SAMPLE, PRETTY_SAMPLE } from './fixtures.test-data';
import { CanvasParseError, newCanvasText, parseCanvas, serializeCanvas } from './format';
import { emptyDoc } from './model';
import { addNodes, deleteItems, makeNode, moveNodes, updateNode } from './ops';

describe('parseCanvas', () => {
  it('reads Obsidian files with every node type and unknown fields', () => {
    const doc = parseCanvas(OBSIDIAN_SAMPLE);
    expect(doc.nodes.map((n) => n.type)).toEqual(['group', 'file', 'file', 'text', 'link']);
    expect(doc.nodes[3].text).toBe('Learn more:\n\n- [[Spec]]\n- [Site](https://example.com) — café');
    expect(doc.nodes[3].styleAttributes).toEqual({ border: 'dashed' });
    expect(doc.edges[1]).toMatchObject({ fromEnd: 'arrow', toEnd: 'none', color: '2' });
    expect([...doc.extra.keys()]).toEqual(['metadata']);
    expect(doc.format).toMatchObject({ layout: 'obsidian', trailingNewline: false, keys: ['nodes', 'edges', 'metadata'] });
  });

  it('treats an empty file as an empty canvas, as Obsidian creates them', () => {
    const doc = parseCanvas('');
    expect(doc.nodes).toEqual([]);
    expect(serializeCanvas(doc)).toBe('');
  });

  it('rejects text that is not a canvas', () => {
    expect(() => parseCanvas('{"nodes": [')).toThrow(CanvasParseError);
    expect(() => parseCanvas('[1, 2]')).toThrow(CanvasParseError);
    expect(() => parseCanvas('{"nodes": {}}')).toThrow(CanvasParseError);
  });

  it('gives nodes without a usable id one, deterministically', () => {
    const text = '{"nodes":[{"type":"text","text":"a","x":0,"y":0,"width":1,"height":1},{"id":"x","type":"text","x":0,"y":0,"width":1,"height":1},{"id":"x","type":"text","x":0,"y":0,"width":1,"height":1}]}';
    const ids = parseCanvas(text).nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(3);
    expect(parseCanvas(text).nodes.map((n) => n.id)).toEqual(ids);
  });
});

describe('serializeCanvas', () => {
  it.each([
    ['Obsidian', OBSIDIAN_SAMPLE],
    ['pretty-printed', PRETTY_SAMPLE],
    ['compact', COMPACT_SAMPLE],
  ])('writes an unchanged %s file back byte for byte', (_name, text) => {
    expect(serializeCanvas(parseCanvas(text))).toBe(text);
  });

  it('rewrites only the changed line of an Obsidian file', () => {
    const doc = parseCanvas(OBSIDIAN_SAMPLE);
    const moved = moveNodes(doc, new Set(['8132d4d894c80022']), 20, -10);
    const out = serializeCanvas(moved);
    const before = OBSIDIAN_SAMPLE.split('\n');
    const after = out.split('\n');
    expect(after).toHaveLength(before.length);
    const changed = after.map((line, i) => (line === before[i] ? null : i)).filter((i) => i !== null);
    expect(changed).toEqual([3]);
    expect(after[3]).toBe('\t\t{"id":"8132d4d894c80022","type":"file","file":"Projects/Plan.md","x":-260,"y":-210,"width":570,"height":560,"color":"6"},');
    // Escapes as written stay on the lines that did not change.
    expect(out).toContain('\\u2014 caf\\u00e9');
  });

  it('keeps unknown fields of an edited node, in place', () => {
    const doc = parseCanvas(OBSIDIAN_SAMPLE);
    const out = serializeCanvas(updateNode(doc, '59e896bc8da20699', { text: 'Changed' }));
    expect(out).toContain('{"id":"59e896bc8da20699","type":"text","text":"Changed","x":40,"y":-440,"width":250,"height":160,"styleAttributes":{"border":"dashed"}}');
    expect(out).toContain('\t"metadata":{"version":"1.0-1.0","frontmatter":{}}\n}');
  });

  it('round-trips again after an edit and its undo', () => {
    const doc = parseCanvas(OBSIDIAN_SAMPLE);
    const edited = deleteItems(doc, new Set(['0ba565e7f30e0652']), new Set());
    expect(edited.edges).toHaveLength(1);
    expect(serializeCanvas(parseCanvas(serializeCanvas(edited)))).toBe(serializeCanvas(edited));
    // Undo restores the earlier document object, which is written as the original text.
    expect(serializeCanvas(doc)).toBe(OBSIDIAN_SAMPLE);
  });

  it('keeps a pretty-printed layout and its final newline', () => {
    const doc = parseCanvas(PRETTY_SAMPLE);
    const out = serializeCanvas(updateNode(doc, 'b', { text: 'Earth' }));
    // The untouched node keeps its own text (its list on one line); the edited one is re-indented.
    expect(out).toBe(PRETTY_SAMPLE.replace('World', 'Earth'));
  });

  it('keeps the key order of a compact file', () => {
    const doc = parseCanvas(COMPACT_SAMPLE);
    const out = serializeCanvas(updateNode(doc, 'a', { text: 'z' }));
    expect(out.startsWith('{"edges":[{"id":"e","fromNode":"a","toNode":"b"}],"nodes":[{"id":"a","type":"text","text":"z"')).toBe(true);
  });

  it('writes a new canvas in Obsidian layout', () => {
    expect(newCanvasText()).toBe('{\n\t"nodes":[],\n\t"edges":[]\n}');
    const doc = addNodes(parseCanvas(''), [{ id: 'n1', type: 'text', text: 'Hi', x: 0, y: 0, width: 250, height: 60 }]);
    expect(serializeCanvas(doc)).toBe('{\n\t"nodes":[\n\t\t{"id":"n1","type":"text","text":"Hi","x":0,"y":0,"width":250,"height":60}\n\t],\n\t"edges":[]\n}');
  });

  it('lists nodes and edges first when a file had neither', () => {
    const doc = parseCanvas('{\n\t"foo":1\n}');
    const out = serializeCanvas(addNodes(doc, [makeNode(emptyDoc(), 'text', { x: 0, y: 0 }, { text: 'a' })]));
    expect(Object.keys(JSON.parse(out))).toEqual(['nodes', 'edges', 'foo']);
    expect(out).toContain('\t"foo":1\n}');
  });

  it('writes new nodes with fields in Obsidian order', () => {
    const text = makeNode(emptyDoc(), 'text', { x: 125, y: 30 }, { text: 'x' });
    expect(Object.keys(text)).toEqual(['id', 'type', 'text', 'x', 'y', 'width', 'height']);
    expect(text).toMatchObject({ x: 0, y: 0, width: 250, height: 60 });
    const group = makeNode(emptyDoc(), 'group', { x: 0, y: 0 }, { label: 'G' });
    expect(Object.keys(group)).toEqual(['id', 'type', 'x', 'y', 'width', 'height', 'label']);
    expect(text.id).toMatch(/^[0-9a-f]{16}$/);
  });
});
