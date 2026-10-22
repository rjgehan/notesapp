import { describe, expect, it } from 'vitest';
import {
  activePaneOf,
  activeTab,
  adoptUrl,
  closeMany,
  closePane,
  closeTab,
  createWorkspace,
  exclusiveOwner,
  focusAdjacentPane,
  moveTab,
  navigate,
  NEW_TAB_ROUTE,
  openTab,
  paneOrder,
  pathOfRoute,
  pop,
  rebase,
  reopenClosed,
  resize,
  sanitize,
  selectAdjacentTab,
  selectTab,
  split,
  splitRoute,
  togglePin,
  type Workspace,
} from './model';

const routes = (ws: Workspace, paneId = ws.activePane) => ws.panes[paneId].tabs.map((t) => t.route);

describe('routes', () => {
  it('splits a route and finds its path', () => {
    expect(splitRoute('/n/a%20b.md?line=3#H')).toEqual({ pathname: '/n/a%20b.md', search: '?line=3', hash: '#H' });
    expect(pathOfRoute('/n/Daily%20Notes/x.md#H')).toBe('Daily Notes/x.md');
    expect(pathOfRoute('/x/tasks')).toBeNull();
  });
});

describe('navigation in a tab', () => {
  it('pushes into the tab history and clears forward', () => {
    let ws = createWorkspace('/n/a.md');
    ws = navigate(ws, '/n/b.md', 'push');
    ws = navigate(ws, '/n/c.md', 'push');
    expect(activeTab(ws)).toMatchObject({ route: '/n/c.md', back: ['/n/a.md', '/n/b.md'], forward: [] });
    ws = pop(ws, '/n/b.md', 'back').ws;
    expect(activeTab(ws)).toMatchObject({ route: '/n/b.md', back: ['/n/a.md'], forward: ['/n/c.md'] });
    ws = navigate(ws, '/n/d.md', 'push');
    expect(activeTab(ws).forward).toEqual([]);
  });

  it('replace changes only the route', () => {
    const ws = navigate(createWorkspace('/n/a.md'), '/n/a.md?mode=read', 'replace');
    expect(activeTab(ws)).toMatchObject({ route: '/n/a.md?mode=read', back: [] });
  });

  it('a pinned tab opens another file in a new tab next to it', () => {
    let ws = createWorkspace('/n/a.md');
    ws = togglePin(ws, ws.activePane, activeTab(ws).id);
    ws = openTab(ws, '/n/z.md', { background: true });
    ws = navigate(ws, '/n/b.md', 'push');
    expect(routes(ws)).toEqual(['/n/a.md', '/n/b.md', '/n/z.md']);
    expect(activeTab(ws).route).toBe('/n/b.md');
    // A heading in the same note stays in the pinned tab.
    ws = selectTab(ws, ws.activePane, activePaneOf(ws).tabs[0].id);
    ws = navigate(ws, '/n/a.md#H', 'push');
    expect(activeTab(ws).route).toBe('/n/a.md#H');
  });

  it('back walks the tab history and corrects the URL when the browser entry belongs elsewhere', () => {
    let ws = createWorkspace('/n/a.md');
    ws = navigate(ws, '/n/b.md', 'push');
    const result = pop(ws, '/n/other.md', 'back');
    expect(activeTab(result.ws).route).toBe('/n/a.md');
    expect(result.url).toBe('/n/a.md');
  });

  it('without history, back selects the tab showing that route, else keeps the tab', () => {
    let ws = createWorkspace('/n/a.md');
    ws = openTab(ws, '/n/b.md');
    const toOrigin = pop(ws, '/n/a.md', 'back');
    expect(activeTab(toOrigin.ws).route).toBe('/n/a.md');
    expect(toOrigin.url).toBeNull();
    const nowhere = pop(ws, '/n/q.md', 'back');
    expect(activeTab(nowhere.ws).route).toBe('/n/b.md');
    expect(nowhere.url).toBe('/n/b.md');
  });

  it('forward walks forward', () => {
    let ws = navigate(createWorkspace('/n/a.md'), '/n/b.md', 'push');
    ws = pop(ws, '/n/a.md', 'back').ws;
    const { ws: next, url } = pop(ws, '/n/b.md', 'forward');
    expect(activeTab(next)).toMatchObject({ route: '/n/b.md', back: ['/n/a.md'], forward: [] });
    expect(url).toBeNull();
  });
});

describe('tabs', () => {
  it('opens after the active tab, in the foreground or background', () => {
    let ws = createWorkspace('/n/a.md');
    ws = openTab(ws, '/n/c.md');
    ws = selectTab(ws, ws.activePane, activePaneOf(ws).tabs[0].id);
    ws = openTab(ws, '/n/b.md', { background: true });
    expect(routes(ws)).toEqual(['/n/a.md', '/n/b.md', '/n/c.md']);
    expect(activeTab(ws).route).toBe('/n/a.md');
  });

  it('closing selects the right neighbour, else the left; the last tab becomes a new tab', () => {
    let ws = createWorkspace('/n/a.md');
    ws = openTab(ws, '/n/b.md');
    ws = openTab(ws, '/n/c.md');
    ws = selectTab(ws, ws.activePane, activePaneOf(ws).tabs[1].id);
    ws = closeTab(ws, ws.activePane, activeTab(ws).id);
    expect(activeTab(ws).route).toBe('/n/c.md');
    ws = closeTab(ws, ws.activePane, activeTab(ws).id);
    expect(activeTab(ws).route).toBe('/n/a.md');
    ws = closeTab(ws, ws.activePane, activeTab(ws).id);
    expect(routes(ws)).toEqual([NEW_TAB_ROUTE]);
    expect(ws.closed.map((c) => c.tab.route)).toEqual(['/n/b.md', '/n/c.md', '/n/a.md']);
  });

  it('keeps a pinned tab unless forced', () => {
    let ws = createWorkspace('/n/a.md');
    ws = togglePin(ws, ws.activePane, activeTab(ws).id);
    expect(closeTab(ws, ws.activePane, activeTab(ws).id)).toBe(ws);
    expect(routes(closeTab(ws, ws.activePane, activeTab(ws).id, true))).toEqual([NEW_TAB_ROUTE]);
  });

  it('closes others or those to the right, sparing pinned tabs', () => {
    let ws = createWorkspace('/n/a.md');
    ws = togglePin(ws, ws.activePane, activeTab(ws).id);
    for (const r of ['/n/b.md', '/n/c.md', '/n/d.md']) ws = openTab(ws, r);
    const c = activePaneOf(ws).tabs[2];
    expect(routes(closeMany(ws, ws.activePane, c.id, 'right'))).toEqual(['/n/a.md', '/n/b.md', '/n/c.md']);
    const others = closeMany(ws, ws.activePane, c.id, 'others');
    expect(routes(others)).toEqual(['/n/a.md', '/n/c.md']);
    expect(activeTab(others).route).toBe('/n/c.md');
  });

  it('reopens the last closed tab where it was, with its history', () => {
    let ws = navigate(createWorkspace('/n/a.md'), '/n/a2.md', 'push');
    ws = openTab(ws, '/n/b.md');
    ws = selectTab(ws, ws.activePane, activePaneOf(ws).tabs[0].id);
    ws = closeTab(ws, ws.activePane, activeTab(ws).id);
    ws = reopenClosed(ws);
    expect(routes(ws)).toEqual(['/n/a2.md', '/n/b.md']);
    expect(activeTab(ws)).toMatchObject({ route: '/n/a2.md', back: ['/n/a.md'] });
    expect(ws.closed).toEqual([]);
    expect(reopenClosed(ws)).toBe(ws);
  });

  it('reorders by drag, both ways', () => {
    let ws = createWorkspace('/n/a.md');
    ws = openTab(ws, '/n/b.md');
    ws = openTab(ws, '/n/c.md');
    const [a, , c] = activePaneOf(ws).tabs;
    expect(routes(moveTab(ws, ws.activePane, a.id, ws.activePane, 3))).toEqual(['/n/b.md', '/n/c.md', '/n/a.md']);
    expect(routes(moveTab(ws, ws.activePane, c.id, ws.activePane, 0))).toEqual(['/n/c.md', '/n/a.md', '/n/b.md']);
  });

  it('cycles tabs', () => {
    let ws = openTab(createWorkspace('/n/a.md'), '/n/b.md');
    ws = selectAdjacentTab(ws, 1);
    expect(activeTab(ws).route).toBe('/n/a.md');
    ws = selectAdjacentTab(ws, -1);
    expect(activeTab(ws).route).toBe('/n/b.md');
  });
});

describe('splits', () => {
  it('splits right with the same route, then down inside the new pane', () => {
    let ws = createWorkspace('/n/a.md');
    const first = ws.activePane;
    ws = split(ws, first, 'right');
    expect(ws.layout).toMatchObject({ type: 'split', dir: 'row', sizes: [0.5, 0.5] });
    expect(activeTab(ws).route).toBe('/n/a.md');
    expect(ws.activePane).not.toBe(first);
    const second = ws.activePane;
    ws = split(ws, second, 'down');
    expect(ws.layout).toMatchObject({ type: 'split', dir: 'row', children: [{ type: 'pane', id: first }, { type: 'split', dir: 'column' }] });
    expect(paneOrder(ws)).toHaveLength(3);
  });

  it('a split in the same direction adds a sibling and halves the size', () => {
    let ws = createWorkspace('/n/a.md');
    const first = ws.activePane;
    ws = split(ws, first, 'right');
    ws = split(ws, first, 'left');
    expect(ws.layout.type === 'split' && ws.layout.children.length).toBe(3);
    expect(ws.layout.type === 'split' && ws.layout.sizes).toEqual([0.25, 0.25, 0.5]);
    expect(paneOrder(ws)[1]).toBe(first);
  });

  it('dragging a tab to an edge moves it into a new pane', () => {
    let ws = openTab(createWorkspace('/n/a.md'), '/n/b.md');
    const pane = ws.activePane;
    const b = activeTab(ws);
    ws = split(ws, pane, 'right', { pane, tab: b.id });
    expect(routes(ws, pane)).toEqual(['/n/a.md']);
    expect(activeTab(ws)).toMatchObject({ id: b.id, route: '/n/b.md' });
    // A pane's only tab cannot be split off from itself.
    expect(split(ws, ws.activePane, 'down', { pane: ws.activePane, tab: b.id })).toBe(ws);
  });

  it('moving the last tab of a pane to another pane closes it', () => {
    let ws = createWorkspace('/n/a.md');
    const left = ws.activePane;
    ws = split(ws, left, 'right');
    const right = ws.activePane;
    ws = moveTab(ws, right, activeTab(ws).id, left);
    expect(ws.layout).toEqual({ type: 'pane', id: left });
    expect(routes(ws, left)).toEqual(['/n/a.md', '/n/a.md']);
    expect(ws.activePane).toBe(left);
  });

  it('closing a pane collapses and flattens the layout', () => {
    let ws = createWorkspace('/n/a.md');
    const a = ws.activePane;
    ws = split(ws, a, 'right');
    const b = ws.activePane;
    ws = split(ws, b, 'down');
    const c = ws.activePane;
    ws = closePane(ws, c);
    expect(ws.layout).toMatchObject({ type: 'split', dir: 'row', children: [{ id: a }, { id: b }] });
    expect(ws.activePane).toBe(b);
    ws = closePane(ws, a);
    expect(ws.layout).toEqual({ type: 'pane', id: b });
    expect(ws.closed).toHaveLength(2);
    expect(closePane(ws, b)).toBe(ws);
  });

  it('closing the last tab of a split pane closes the pane', () => {
    let ws = createWorkspace('/n/a.md');
    const a = ws.activePane;
    ws = split(ws, a, 'down');
    ws = closeTab(ws, ws.activePane, activeTab(ws).id);
    expect(ws.layout).toEqual({ type: 'pane', id: a });
    expect(ws.activePane).toBe(a);
  });

  it('resizes with normalized, bounded fractions', () => {
    let ws = createWorkspace('/n/a.md');
    ws = split(ws, ws.activePane, 'right');
    const id = ws.layout.type === 'split' ? ws.layout.id : '';
    ws = resize(ws, id, [3, 1]);
    expect(ws.layout.type === 'split' && ws.layout.sizes).toEqual([0.75, 0.25]);
    ws = resize(ws, id, [1, 0]);
    const sizes = ws.layout.type === 'split' ? ws.layout.sizes : [];
    expect(sizes[1]).toBeGreaterThan(0.05);
    expect(sizes[0] + sizes[1]).toBeCloseTo(1);
  });

  it('focuses panes in layout order', () => {
    let ws = createWorkspace('/n/a.md');
    const a = ws.activePane;
    ws = split(ws, a, 'right');
    expect(focusAdjacentPane(ws, 1).activePane).toBe(a);
  });

  it('names the pane that owns a file shown in two panes', () => {
    let ws = createWorkspace('/n/s.sheet');
    const a = ws.activePane;
    ws = split(ws, a, 'right');
    const b = ws.activePane;
    expect(exclusiveOwner(ws, 's.sheet')).toBe(b);
    ws = navigate(ws, '/n/other.md', 'push');
    expect(exclusiveOwner(ws, 's.sheet')).toBe(a);
    expect(exclusiveOwner(ws, 'none.md')).toBeNull();
  });
});

describe('moves and startup', () => {
  it('rebases routes of moved files and folders everywhere', () => {
    let ws = navigate(createWorkspace('/n/F/a.md?line=2'), '/n/b.md', 'push');
    ws = openTab(ws, '/n/F/c.md#H');
    ws = closeTab(ws, ws.activePane, activeTab(ws).id);
    ws = rebase(ws, 'F', 'G', 'folder');
    expect(activeTab(ws).back).toEqual(['/n/G/a.md?line=2']);
    expect(ws.closed[0].tab.route).toBe('/n/G/c.md#H');
    const again = rebase(ws, 'b.md', 'B%.md', 'file');
    expect(activeTab(again).route).toBe('/n/B%25.md');
    expect(rebase(again, 'zzz', 'y', 'folder')).toBe(again);
  });

  it('adopts the URL: selects a tab showing it, else navigates the active tab', () => {
    let ws = openTab(createWorkspace('/n/a.md'), '/n/b.md');
    expect(activeTab(adoptUrl(ws, '/n/a.md')).route).toBe('/n/a.md');
    ws = adoptUrl(ws, '/n/c.md');
    expect(routes(ws)).toEqual(['/n/a.md', '/n/c.md']);
    expect(activeTab(ws).back).toEqual(['/n/b.md']);
  });

  it('sanitizes what was persisted', () => {
    const real = createWorkspace('/n/a.md');
    const two = split(real, real.activePane, 'right');
    expect(sanitize(JSON.parse(JSON.stringify(two)))).toEqual(two);
    expect(sanitize(null)).toBeNull();
    expect(sanitize({ ...two, activePane: 'nope' })).toBeNull();
    expect(sanitize({ ...two, layout: { type: 'pane', id: two.activePane } })).toBeNull();
  });
});
