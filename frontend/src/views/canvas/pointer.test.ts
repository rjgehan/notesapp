import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockVault } from '../../api/mock/vault';
import { fakeApi, sessionDeps } from '../../test/fakes';
import { DocumentSession } from '../../sync/DocumentSession';
import { CanvasController } from './controller';
import { nodeRect, type CanvasNode } from './model';
import { CanvasPointer, nodeAt, nodesInBox, resizedRect, sideFacing, type PointerCallbacks } from './pointer';

const node = (id: string, x: number, y: number, extra: Partial<CanvasNode> = {}): CanvasNode => ({ id, type: 'text', text: id, x, y, width: 100, height: 60, ...extra });

const BOARD = JSON.stringify({
  nodes: [node('g', -40, -40, { type: 'group', width: 600, height: 200 }), node('a', 0, 0), node('b', 300, 0), node('far', 2000, 2000)],
  edges: [{ id: 'ab', fromNode: 'a', toNode: 'b' }],
});

let stage: HTMLDivElement;
let detach: () => void;

/** A stage with one element per node (with handles) and edge, like the view renders. */
function renderStage(controller: CanvasController): void {
  stage.innerHTML = '';
  for (const n of controller.doc!.nodes) {
    const el = document.createElement('div');
    el.dataset.nodeId = n.id;
    el.innerHTML = `<div class="canvas-node-container"><p>text <a class="internal-link" data-href="Plan">Plan</a></p></div><div data-handle="se"></div><div data-connect="right"></div>`;
    stage.appendChild(el);
  }
  const edge = document.createElement('div');
  edge.dataset.edgeId = 'ab';
  stage.appendChild(edge);
}

const el = (sel: string) => stage.querySelector(sel)!;

function fire(target: Element, type: string, x: number, y: number, init: PointerEventInit = {}): void {
  target.dispatchEvent(
    new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1, ...init }),
  );
}

/** Press on `target`, move through the points, release at the last one. */
function drag(target: Element, points: Array<[number, number]>, init: PointerEventInit = {}): void {
  const [first, ...rest] = points;
  fire(target, 'pointerdown', first[0], first[1], init);
  for (const [x, y] of rest) fire(stage, 'pointermove', x, y, init);
  const last = points[points.length - 1];
  fire(stage, 'pointerup', last[0], last[1], init);
}

async function setup() {
  const vault = new MockVault(false);
  vault.createFile({ path: 'B.canvas', content: BOARD }, 'other-device-1');
  const session = new DocumentSession('B.canvas', sessionDeps(fakeApi(vault).api));
  await session.ready;
  const controller = new CanvasController();
  controller.bind(session);
  controller.setStage(1000, 800);
  renderStage(controller);
  const cb = {
    menu: vi.fn(),
    doubleTapNode: vi.fn(),
    doubleTapEdge: vi.fn(),
    doubleTapBackground: vi.fn(),
    activate: vi.fn((target: Element) => !!target.closest('a')),
    spaceHeld: () => false,
    hover: vi.fn(),
  } satisfies PointerCallbacks;
  detach = new CanvasPointer(stage, controller, cb).attach();
  const rect = (id: string) => nodeRect(controller.doc!.nodes.find((n) => n.id === id)!);
  return { controller, cb, rect };
}

beforeEach(() => {
  stage = document.createElement('div');
  stage.tabIndex = 0;
  document.body.appendChild(stage);
});

afterEach(() => {
  detach?.();
  stage.remove();
  vi.useRealTimers();
});

describe('canvas pointer gestures', () => {
  it('selects with a click and toggles with Shift', async () => {
    const { controller } = await setup();
    drag(el('[data-node-id="a"]'), [[10, 10]]);
    expect([...controller.getState().selection.nodes]).toEqual(['a']);
    drag(el('[data-node-id="b"]'), [[310, 10]], { shiftKey: true });
    expect([...controller.getState().selection.nodes]).toEqual(['a', 'b']);
    drag(el('[data-node-id="a"]'), [[10, 10]], { shiftKey: true });
    expect([...controller.getState().selection.nodes]).toEqual(['b']);
    drag(stage, [[700, 700]]);
    expect(controller.getState().selection.nodes.size).toBe(0);
  });

  it('drags a node on the grid, and a group with what it contains', async () => {
    const { controller, rect } = await setup();
    drag(el('[data-node-id="a"]'), [
      [10, 10],
      [30, 20],
      [57, 31],
    ]);
    expect(controller.getState().gesture).toBeNull();
    expect(rect('a')).toMatchObject({ x: 40, y: 20 });
    drag(el('[data-node-id="a"]'), [
      [50, 30],
      [53, 33],
      [57, 37],
    ], { altKey: true });
    expect(rect('a')).toMatchObject({ x: 47, y: 27 });
    drag(el('[data-node-id="g"]'), [
      [-30, -30],
      [-10, -30],
      [70, -30],
    ]);
    expect(rect('g').x).toBe(60);
    expect(rect('a').x).toBe(147);
    expect(rect('b').x).toBe(400);
    expect(rect('far').x).toBe(2000);
  });

  it('draws a selection box with the mouse and pans with a finger', async () => {
    const { controller } = await setup();
    drag(stage, [
      [-60, -60],
      [200, 100],
      [450, 100],
    ]);
    expect([...controller.getState().selection.nodes].sort()).toEqual(['a', 'b']);
    drag(
      stage,
      [
        [700, 700],
        [650, 690],
        [600, 680],
      ],
      { pointerType: 'touch' },
    );
    expect(controller.getState().view).toMatchObject({ x: -100, y: -20, zoom: 1 });
  });

  it('pinches with two fingers', async () => {
    const { controller } = await setup();
    const touch = (id: number) => ({ pointerType: 'touch', pointerId: id });
    fire(stage, 'pointerdown', 400, 400, touch(1));
    fire(stage, 'pointerdown', 600, 400, touch(2));
    fire(stage, 'pointermove', 300, 400, touch(1));
    fire(stage, 'pointermove', 700, 400, touch(2));
    fire(stage, 'pointerup', 300, 400, touch(1));
    fire(stage, 'pointerup', 700, 400, touch(2));
    const v = controller.getState().view;
    expect(v.zoom).toBe(2);
    // The world point under the fingers' midpoint stayed there.
    expect(controller.screenToWorld({ x: 500, y: 400 })).toEqual({ x: 500, y: 400 });
  });

  it('opens the menu on a long press and acts on double taps', async () => {
    vi.useFakeTimers();
    const { cb } = await setup();
    fire(el('[data-node-id="a"]'), 'pointerdown', 10, 10, { pointerType: 'touch' });
    vi.advanceTimersByTime(500);
    expect(cb.menu).toHaveBeenCalledWith(expect.objectContaining({ kind: 'node', id: 'a' }));
    fire(stage, 'pointerup', 10, 10, { pointerType: 'touch' });
    expect(cb.doubleTapNode).not.toHaveBeenCalled();
    drag(el('[data-node-id="b"]'), [[310, 10]]);
    drag(el('[data-node-id="b"]'), [[311, 11]]);
    expect(cb.doubleTapNode).toHaveBeenCalledWith('b', expect.anything());
    drag(stage, [[700, 700]]);
    drag(stage, [[702, 700]]);
    expect(cb.doubleTapBackground).toHaveBeenCalledWith({ x: 702, y: 700 });
    drag(el('[data-edge-id="ab"]'), [[200, 30]]);
    drag(el('[data-edge-id="ab"]'), [[200, 30]]);
    expect(cb.doubleTapEdge).toHaveBeenCalledWith('ab');
  });

  it('lets links in cards act on a tap', async () => {
    const { cb } = await setup();
    drag(el('[data-node-id="a"] a'), [[10, 10]]);
    expect(cb.activate).toHaveBeenCalled();
    drag(el('[data-node-id="a"] a'), [[10, 10]]);
    // An activation is never also a double tap.
    expect(cb.doubleTapNode).not.toHaveBeenCalled();
  });

  it('resizes from a handle, at least to the minimum size', async () => {
    const { controller, rect } = await setup();
    drag(el('[data-node-id="b"] [data-handle]'), [
      [400, 60],
      [450, 100],
      [455, 105],
    ]);
    expect(rect('b')).toEqual({ x: 300, y: 0, width: 160, height: 100 });
    expect(resizedRect({ x: 0, y: 0, width: 100, height: 60 }, 'nw', 500, 500, 0)).toEqual({ x: 60, y: 30, width: 40, height: 30 });
    expect(controller.getState().canUndo).toBe(true);
  });

  it('connects two nodes, or a node to a new card', async () => {
    const { controller } = await setup();
    drag(el('[data-node-id="a"] [data-connect]'), [
      [100, 30],
      [200, 30],
      [305, 20],
    ]);
    const doc = controller.getState().doc!;
    expect(doc.edges).toHaveLength(2);
    expect(doc.edges[1]).toMatchObject({ fromNode: 'a', fromSide: 'right', toNode: 'b', toSide: 'left' });
    drag(el('[data-node-id="b"] [data-connect]'), [
      [400, 30],
      [600, 30],
      [700, 30],
    ]);
    const after = controller.getState().doc!;
    expect(after.nodes).toHaveLength(5);
    const card = after.nodes[after.nodes.length - 1];
    expect(after.edges[2]).toMatchObject({ fromNode: 'b', toNode: card.id, toSide: 'left' });
    expect(controller.getState().editing).toBe(card.id);
  });

  it('pans with the wheel and zooms with Ctrl', async () => {
    const { controller } = await setup();
    stage.dispatchEvent(new WheelEvent('wheel', { deltaX: 10, deltaY: 30, bubbles: true, cancelable: true }));
    expect(controller.getState().view).toMatchObject({ x: -10, y: -30 });
    stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -10, ctrlKey: true, clientX: 0, clientY: 0, bubbles: true, cancelable: true }));
    expect(controller.getState().view.zoom).toBeCloseTo(Math.exp(0.1));
  });
});

describe('canvas hit tests', () => {
  it('finds cards before the groups behind them', async () => {
    const { controller } = await setup();
    expect(nodeAt(controller, { x: 10, y: 10 })).toBe('a');
    expect(nodeAt(controller, { x: 200, y: 10 })).toBe('g');
    expect(nodeAt(controller, { x: 10, y: 10 }, 'a')).toBe('g');
    expect(nodeAt(controller, { x: 5000, y: 10 })).toBeNull();
    expect(nodesInBox(controller, { x: -100, y: -100, width: 700, height: 300 }).sort()).toEqual(['a', 'b', 'g']);
    expect(nodesInBox(controller, { x: 50, y: 0, width: 10, height: 10 })).toEqual(['a']);
    expect(sideFacing({ x: 0, y: 0 }, { x: -100, y: 10 })).toBe('left');
    expect(sideFacing({ x: 0, y: 0 }, { x: 10, y: 100 })).toBe('bottom');
  });
});
