import { describe, expect, it } from 'vitest';
import { dragDivider, dropZone, layoutGeometry } from './geometry';
import type { Layout } from './model';

describe('layoutGeometry', () => {
  it('places panes and dividers of nested splits', () => {
    const layout: Layout = {
      type: 'split',
      id: 's1',
      dir: 'row',
      sizes: [0.5, 0.5],
      children: [
        { type: 'pane', id: 'a' },
        { type: 'split', id: 's2', dir: 'column', sizes: [0.25, 0.75], children: [{ type: 'pane', id: 'b' }, { type: 'pane', id: 'c' }] },
      ],
    };
    const { panes, dividers } = layoutGeometry(layout);
    expect(panes.a).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(panes.b).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.25 });
    expect(panes.c).toEqual({ x: 0.5, y: 0.25, w: 0.5, h: 0.75 });
    expect(dividers.map((d) => [d.split, d.index, d.at])).toEqual([
      ['s1', 1, 0.5],
      ['s2', 1, 0.25],
    ]);
  });

  it('a single pane fills the workspace', () => {
    expect(layoutGeometry({ type: 'pane', id: 'a' }).panes.a).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('dragDivider', () => {
  it('moves only the two neighbours, within bounds', () => {
    expect(dragDivider([0.25, 0.25, 0.5], 2, 0.6)).toEqual([0.25, 0.35, 0.4]);
    const clamped = dragDivider([0.5, 0.5], 1, 0.99);
    expect(clamped[1]).toBeCloseTo(0.1);
    expect(clamped[0] + clamped[1]).toBeCloseTo(1);
  });
});

describe('dropZone', () => {
  it('edges split, the middle moves', () => {
    expect(dropZone(0.1, 0.5)).toBe('left');
    expect(dropZone(0.95, 0.5)).toBe('right');
    expect(dropZone(0.5, 0.05)).toBe('up');
    expect(dropZone(0.5, 0.9)).toBe('down');
    expect(dropZone(0.5, 0.5)).toBe('center');
  });
});
