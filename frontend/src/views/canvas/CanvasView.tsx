// The canvas view (ROADMAP item 25): an infinite board of cards, notes, images, links and groups
// joined by edges, stored as an Obsidian-compatible JSON Canvas `.canvas` file. A lazy chunk.
//
// The world layer is one CSS-transformed element (pan and zoom change only its transform); nodes
// are absolutely positioned, memoized components, culled to the visible area, and drawn as plain
// boxes below 45 % zoom, so boards of 500+ nodes stay smooth. Gestures are in pointer.ts, state
// and session sync in controller.ts, file-level operations in actions.ts.
import {
  ArrowLeftRight,
  BringToFront,
  ClipboardPaste,
  Copy,
  CopyPlus,
  ExternalLink,
  FileOutput,
  FilePlus,
  Focus,
  Globe,
  Group,
  Image,
  Maximize,
  MoveRight,
  Palette,
  Pencil,
  Redo2,
  Scissors,
  SendToBack,
  StickyNote,
  Tag,
  TextCursorInput,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { useLocation } from 'react-router';
import { currentTree, useTree, useVaultSettings } from '../../api/hooks';
import type { FileEntry } from '../../api/types';
import { ContextMenu, type MenuEntry } from '../../components/overlays/ContextMenu';
import { Picker } from '../../components/overlays/Picker';
import { SaveStatus } from '../../components/SaveStatus';
import { INTERNAL_PATH_TYPE } from '../../editor/pasteAndDrop';
import { pickFiles } from '../../features/attachments';
import { fuzzyRank } from '../../features/fuzzy';
import { displayName, folderOf } from '../../features/paths';
import { isCoarsePointer, modKey } from '../../features/platform';
import { usePrefs } from '../../state/prefs';
import { toast } from '../../state/toasts';
import { moveMap } from '../../sync/instance';
import { useDocumentSession, useSessionSnapshot } from '../../sync/useTextDocument';
import TextView from '../TextView';
import type { FileViewProps } from '../registry';
import {
  activateInCard,
  addFileNodes,
  convertToNote,
  openFileNode,
  openLinkNode,
  promptEdgeLabel,
  promptGroupLabel,
  promptLink,
  uploadAndAdd,
} from './actions';
import { clearActiveCanvas, setActiveCanvas, type ActiveCanvas } from './active';
import { CanvasTitle } from './CanvasTitle';
import './canvas.css';
import { CanvasController, type Gesture, type Viewport } from './controller';
import { EdgeLabel, EdgeView } from './EdgeView';
import {
  boundsOf,
  cssColor,
  danglingGeometry,
  edgeFromEnd,
  edgeGeometry,
  edgeToEnd,
  isSide,
  nodeRect,
  PRESET_COLORS,
  rectsIntersect,
  sideAnchor,
  sideToward,
  str,
  type CanvasDoc,
  type CanvasNode,
  type Point,
  type Rect,
} from './model';
import { NodeView, type Lod, type RenderEnv } from './NodeView';
import { parseFragment } from './ops';
import { CanvasPointer, type MenuRequest } from './pointer';
import { mergeCanvas } from './merge';
import { setCanvasMerge } from './register';

// The conflict banner's Compare offers the node-level merge while a canvas is open.
setCanvasMerge(mergeCanvas);

const LOW_DETAIL_ZOOM = 0.45;
const VIEW_KEY = 'notesapp:canvas-view:';

/** Where this device last looked at a canvas: the world point at the middle of the stage, and the zoom. */
interface SavedView {
  cx: number;
  cy: number;
  zoom: number;
}

function loadViewport(path: string): SavedView | undefined {
  try {
    const raw = localStorage.getItem(VIEW_KEY + path);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as SavedView;
    return Number.isFinite(v.cx) && Number.isFinite(v.cy) && Number.isFinite(v.zoom) && v.zoom > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

function saveViewport(path: string, v: Viewport, stage: { width: number; height: number }): void {
  try {
    const saved: SavedView = {
      cx: Math.round((stage.width / 2 - v.x) / v.zoom),
      cy: Math.round((stage.height / 2 - v.y) / v.zoom),
      zoom: Math.round(v.zoom * 1000) / 1000,
    };
    localStorage.setItem(VIEW_KEY + path, JSON.stringify(saved));
  } catch {
    // Storage full or disabled: the viewport is a convenience.
  }
}

const baseRects = new WeakMap<CanvasNode, Rect>();

function rectOf(n: CanvasNode): Rect {
  let r = baseRects.get(n);
  if (!r) {
    r = nodeRect(n);
    baseRects.set(n, r);
  }
  return r;
}

/** Each node's rectangle as drawn: its own, or moved or resized by the gesture in progress. */
function displayRects(doc: CanvasDoc, gesture: Gesture | null): Map<string, Rect> {
  const out = new Map<string, Rect>();
  for (const n of doc.nodes) {
    let r = rectOf(n);
    if (gesture?.kind === 'move' && gesture.ids.has(n.id)) r = { ...r, x: r.x + gesture.dx, y: r.y + gesture.dy };
    else if (gesture?.kind === 'resize' && gesture.id === n.id) r = gesture.rect;
    out.set(n.id, r);
  }
  return out;
}

export default function CanvasView({ path, entry }: FileViewProps) {
  const session = useDocumentSession(path);
  const snapshot = useSessionSnapshot(session);
  const [initialView] = useState(() => loadViewport(path));
  const [controller] = useState(() => new CanvasController());
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const tree = useTree().data;
  const settings = useVaultSettings();
  const loadRemoteImages = usePrefs((s) => s.loadRemoteImages);
  const location = useLocation();
  const stage = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [hover, setHover] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ req: MenuRequest; items: MenuEntry[] } | null>(null);
  const [picker, setPicker] = useState<Point | null>(null);
  // The colour swatches belong to the selection they were opened for.
  const [colorsFor, setColorsFor] = useState<object | null>(null);
  const [textMode, setTextMode] = useState(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const space = useRef(false);
  const fitted = useRef(false);
  const hasDoc = state.doc !== null;
  const env = useMemo<RenderEnv | null>(() => (tree ? { tree, settings, loadRemoteImages, canvasPath: path } : null), [tree, settings, loadRemoteImages, path]);
  /** The stage is on screen (effects that need its element run again when it appears). */
  const stageShown = hasDoc && env !== null && !textMode;
  const lastPointer = useRef<Point | null>(null);

  // The session's text is the document (controller.ts); written back on unmount before release.
  useLayoutEffect(() => {
    controller.bind(session);
    return () => controller.unbind();
  }, [controller, session]);

  useEffect(() => {
    const write = () => controller.writeNow();
    const onVisibility = () => document.visibilityState === 'hidden' && write();
    window.addEventListener('pagehide', write);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', write);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [controller]);

  // Stage size, for fitting and culling.
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth;
      const height = el.clientHeight;
      controller.setStage(width, height);
      setStageSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [controller, stageShown]);

  // First view of a canvas on this device: everything in sight; a search hit: its card.
  useLayoutEffect(() => {
    if (!stageShown || stageSize.width === 0) return;
    const q = new URLSearchParams(location.search).get('q')?.trim().toLowerCase();
    const doc = controller.doc!;
    if (q) {
      const terms = q.split(/\s+/).filter(Boolean);
      const hit = doc.nodes.find((n) => {
        const hay = [str(n.text), str(n.label), str(n.file), str(n.url)].filter(Boolean).join(' ').toLowerCase();
        return terms.every((t) => hay.includes(t));
      });
      if (hit) {
        controller.select([hit.id]);
        controller.zoomToRect(nodeRect(hit), 1);
        fitted.current = true;
        return;
      }
    }
    if (!fitted.current) {
      fitted.current = true;
      if (initialView) {
        const { cx, cy, zoom } = initialView;
        controller.setView({ zoom, x: stageSize.width / 2 - cx * zoom, y: stageSize.height / 2 - cy * zoom });
      } else controller.zoomToFit();
    }
  }, [stageShown, stageSize.width, stageSize.height, controller, location.search, initialView]);

  // File nodes follow files this page saw move (MoveService rewrites links in notes only).
  const doc = state.doc;
  const readOnly = state.readOnly;
  useEffect(() => {
    if (!tree || !doc || readOnly) return;
    controller.followMoves((file) => {
      if (tree.byPath.has(file)) return null;
      const to = moveMap.lookup(file);
      return to && tree.byPath.has(to) ? to : null;
    });
  }, [tree, doc, readOnly, controller]);

  // Leaving a card editor gives the keyboard back to the board (Delete, arrows, Mod-Z).
  const editing = state.editing;
  const wasEditing = useRef<string | null>(null);
  useEffect(() => {
    if (wasEditing.current && !editing && (document.activeElement === document.body || document.activeElement === null)) {
      stage.current?.focus({ preventScroll: true });
    }
    wasEditing.current = editing;
  }, [editing]);

  // Remember the viewport per canvas on this device.
  useEffect(() => {
    if (!hasDoc) return;
    const t = setTimeout(() => saveViewport(path, state.view, controller.stageSize), 400);
    return () => clearTimeout(t);
  }, [state.view, path, hasDoc, controller]);

  const startEditing = useCallback(
    (id: string) => {
      // Synchronously, inside the tap, so iOS opens the keyboard for the card editor.
      flushSync(() => {
        if (isCoarsePointer()) controller.reveal(id, 1);
        controller.startEditing(id);
      });
    },
    [controller],
  );

  const addCardAt = useCallback(
    (at: Point) => {
      flushSync(() => {
        const id = controller.addText(at, '', { edit: true });
        if (id && isCoarsePointer()) controller.reveal(id, 1);
      });
    },
    [controller],
  );

  /** Where new things go: the last pointer position over the canvas, else the middle of the view. */
  const insertionPoint = useCallback((): Point => {
    const p = lastPointer.current;
    if (p && p.x >= 0 && p.y >= 0 && p.x <= controller.stageSize.width && p.y <= controller.stageSize.height) return controller.screenToWorld(p);
    return controller.viewCenter();
  }, [controller]);

  const addMedia = useCallback(
    (at: Point) => {
      void pickFiles({ accept: 'image/*,video/*,audio/*,application/pdf', multiple: true }).then((files) => uploadAndAdd(controller, files, at, false));
    },
    [controller],
  );

  const pasteText = useCallback(
    (text: string, at?: Point) => {
      const own = CanvasController.pageClipboard();
      const fragment = own && own.text === text ? own.fragment : parseFragment(text);
      if (fragment) {
        controller.pasteFragment(fragment, at);
        return;
      }
      const t = text.trim();
      if (t === '') return;
      const where = at ?? insertionPoint();
      if (/^https?:\/\/\S+$/i.test(t)) controller.addNode({ type: 'link', url: t, x: Math.round(where.x - 200), y: Math.round(where.y - 60), width: 400, height: 120 });
      else controller.addText(where, text);
    },
    [controller, insertionPoint],
  );

  // Gestures.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const pointer = new CanvasPointer(el, controller, {
      menu: (req) => setMenu({ req, items: menuItems(req, controller, { edit: startEditing, addCard: addCardAt, addFile: setPicker, addMedia, pasteText }) }),
      doubleTapNode: (id) => {
        const node = controller.doc?.nodes.find((n) => n.id === id);
        if (!node) return;
        if (node.type === 'text') startEditing(id);
        else if (node.type === 'file') openFileNode(node);
        else if (node.type === 'link') openLinkNode(node);
        else if (node.type === 'group') void promptGroupLabel(controller, id);
      },
      doubleTapEdge: (id) => void promptEdgeLabel(controller, id),
      doubleTapBackground: (world) => {
        if (!controller.getState().readOnly) addCardAt(world);
      },
      activate: (target, nodeId) => activateInCard(controller, target, nodeId),
      spaceHeld: () => space.current,
      hover: setHover,
    });
    const track = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      lastPointer.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    el.addEventListener('pointermove', track);
    const detach = pointer.attach();
    return () => {
      detach();
      el.removeEventListener('pointermove', track);
    };
  }, [controller, startEditing, addCardAt, addMedia, pasteText, stageShown]);

  // Palette commands act on this canvas while it is on screen.
  useEffect(() => {
    const api: ActiveCanvas = {
      path,
      addCard: () => addCardAt(controller.viewCenter()),
      addFile: () => setPicker(controller.viewCenter()),
      addMedia: () => addMedia(controller.viewCenter()),
      addLink: () => void promptLink(controller, controller.viewCenter()),
      groupSelection: () => controller.groupSelection(),
      zoomToFit: () => controller.zoomToFit(),
      zoomToSelection: () => controller.zoomToSelection(),
      undo: () => controller.undo(),
      redo: () => controller.redo(),
    };
    setActiveCanvas(api);
    return () => clearActiveCanvas(api);
  }, [controller, path, addCardAt, addMedia]);

  // Clipboard: copy, cut and paste while the canvas (not a card editor) has the focus.
  useEffect(() => {
    const focused = () => document.activeElement === stage.current;
    const onCopy = (e: ClipboardEvent) => {
      if (!focused()) return;
      const text = e.type === 'cut' ? controller.cutSelection() : controller.copySelection();
      if (text === null || !e.clipboardData) return;
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!focused() || controller.getState().readOnly || !e.clipboardData) return;
      e.preventDefault();
      const files = [...e.clipboardData.files];
      if (files.length) {
        void uploadAndAdd(controller, files, insertionPoint(), true);
        return;
      }
      pasteText(e.clipboardData.getData('text/plain'));
    };
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCopy);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('copy', onCopy);
      document.removeEventListener('cut', onCopy);
      document.removeEventListener('paste', onPaste);
    };
  }, [controller, insertionPoint, pasteText]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== stage.current || e.nativeEvent.isComposing) return;
    const c = controller;
    const mod = modKey(e);
    const key = e.key;
    const sel = state.selection;
    let handled = true;
    if (key === ' ') {
      space.current = true;
      setSpaceHeld(true);
    }
    else if (key === 'Delete' || key === 'Backspace') c.deleteSelection();
    else if (key === 'Escape') c.clearSelection();
    else if (key === 'Enter' && sel.nodes.size === 1) {
      const node = c.doc?.nodes.find((n) => sel.nodes.has(n.id));
      if (node?.type === 'text') startEditing(node.id);
      else if (node?.type === 'file') openFileNode(node);
      else if (node?.type === 'link') openLinkNode(node);
      else if (node?.type === 'group') void promptGroupLabel(c, node.id);
    } else if (mod && key.toLowerCase() === 'z') {
      if (e.shiftKey) c.redo();
      else c.undo();
    } else if (mod && key.toLowerCase() === 'y') c.redo();
    else if (mod && key.toLowerCase() === 'a') c.selectAll();
    else if (mod && key.toLowerCase() === 'd') c.duplicateSelection();
    else if (mod && key.toLowerCase() === 'g') c.groupSelection();
    else if (mod && (key === '=' || key === '+')) c.zoomBy(1.25);
    else if (mod && key === '-') c.zoomBy(0.8);
    else if (mod && key === '0') c.zoomAt(1 / c.getState().view.zoom, { x: c.stageSize.width / 2, y: c.stageSize.height / 2 });
    else if (e.shiftKey && (key === '!' || e.code === 'Digit1')) c.zoomToFit();
    else if (e.shiftKey && (key === '@' || e.code === 'Digit2')) c.zoomToSelection();
    else if (key.startsWith('Arrow') && sel.nodes.size > 0 && !mod) {
      const step = e.shiftKey ? 20 : 1;
      const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
      const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
      const doc = c.doc;
      if (doc) c.moveSelection(sel.nodes, dx, dy, 'nudge');
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onKeyUp = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === ' ') {
      space.current = false;
      setSpaceHeld(false);
    }
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    const types = e.dataTransfer.types;
    if (state.readOnly || !(types.includes(INTERNAL_PATH_TYPE) || types.includes('Files') || types.includes('text/uri-list') || types.includes('text/plain'))) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (state.readOnly) return;
    e.preventDefault();
    const r = stage.current!.getBoundingClientRect();
    const at = controller.screenToWorld({ x: e.clientX - r.left, y: e.clientY - r.top });
    const dt = e.dataTransfer;
    const internal = dt.getData(INTERNAL_PATH_TYPE);
    if (internal) {
      const entry = currentTree().byPath.get(internal);
      if (entry && entry.path !== path) void addFileNodes(controller, [entry], at);
      return;
    }
    if (dt.files.length) {
      void uploadAndAdd(controller, [...dt.files], at, false);
      return;
    }
    const uri = dt.getData('text/uri-list').split('\n').find((l) => l.trim() && !l.startsWith('#'));
    pasteText(uri ?? dt.getData('text/plain'), at);
  };

  // ---------- states without a canvas ----------

  if (textMode) {
    return (
      <div className="canvas-text-mode">
        <div className="canvas-text-mode-bar">
          <span>Editing the canvas file as text.</span>
          <button type="button" className="button button-small" onClick={() => setTextMode(false)} disabled={state.doc === null}>
            Back to canvas
          </button>
        </div>
        <TextView path={path} entry={entry} mode="edit" />
      </div>
    );
  }
  if (!snapshot.loaded) {
    return snapshot.status === 'loading' ? (
      <div className="view-loading" aria-busy="true">
        <div className="skeleton-line" />
      </div>
    ) : (
      <div className="error-panel" role="alert">
        <p className="error-panel-title">This canvas could not be opened.</p>
        <p className="error-panel-detail">{snapshot.error}</p>
        {snapshot.retryAt !== null && <p className="error-panel-detail muted">Retrying automatically…</p>}
        <button type="button" className="button" onClick={() => void session.reload()}>
          Try again
        </button>
      </div>
    );
  }
  if (!env || (!state.doc && !state.error)) {
    return (
      <div className="view-loading" aria-busy="true">
        <div className="skeleton-line" />
      </div>
    );
  }
  if (!state.doc) {
    return (
      <div className="error-panel" role="alert">
        <p className="error-panel-title">This canvas could not be read.</p>
        <p className="error-panel-detail">{state.error}</p>
        <button type="button" className="button" onClick={() => setTextMode(true)}>
          Edit as text
        </button>
      </div>
    );
  }

  return (
    <div className={`canvas-view${state.editing ? ' is-editing' : ''}`}>
      <div className="canvas-header canvas-ui">
        <CanvasTitle key={path} path={path} editable={!state.readOnly} />
        <SaveStatus snapshot={snapshot} compact />
      </div>
      <div
        ref={stage}
        className={`canvas-stage${state.gesture?.kind === 'move' ? ' is-moving' : ''}${spaceHeld ? ' is-panning' : ''}`}
        tabIndex={0}
        role="application"
        aria-label={`Canvas ${displayName(path)}`}
        aria-roledescription="canvas"
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onDragOver={onDragOver}
        onDrop={onDrop}
        style={gridStyle(state.view)}
      >
        <World
          doc={state.doc}
          state={state}
          controller={controller}
          env={env}
          hover={hover}
          stageSize={stageSize}
        />
        {state.doc.nodes.length === 0 && !state.readOnly && (
          <div className="canvas-empty canvas-ui">
            <p>Double-click (or double-tap) anywhere to add a card, or use the toolbar below.</p>
          </div>
        )}
        <SelectionBar
          state={state}
          controller={controller}
          colorsOpen={colorsFor === state.selection}
          setColorsOpen={(open) => setColorsFor(open ? state.selection : null)}
          onEdit={startEditing}
        />
        <Toolbar
          controller={controller}
          readOnly={state.readOnly}
          zoom={state.view.zoom}
          canUndo={state.canUndo}
          canRedo={state.canRedo}
          onAddCard={() => addCardAt(controller.viewCenter())}
          onAddFile={() => setPicker(controller.viewCenter())}
          onAddMedia={() => addMedia(controller.viewCenter())}
          onAddLink={() => void promptLink(controller, controller.viewCenter())}
        />
      </div>
      {menu && (
        <ContextMenu
          x={menu.req.client.x}
          y={menu.req.client.y}
          label="Canvas"
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}
      {picker && <FilePicker canvasPath={path} onClose={() => setPicker(null)} onPick={(entry) => void addFileNodes(controller, [entry], picker)} />}
    </div>
  );
}

/** A dotted grid that pans and zooms with the board (thinned out when zoomed far out). */
function gridStyle(view: Viewport): CSSProperties {
  let step = 20 * view.zoom;
  while (step < 12) step *= 5;
  return { backgroundSize: `${step}px ${step}px`, backgroundPosition: `${view.x}px ${view.y}px` };
}

// ---------- the world layer ----------

interface WorldProps {
  doc: CanvasDoc;
  state: ReturnType<CanvasController['getState']>;
  controller: CanvasController;
  env: RenderEnv;
  hover: string | null;
  stageSize: { width: number; height: number };
}

function World({ doc, state, controller, env, hover, stageSize }: WorldProps) {
  const { view, gesture, selection, editing, readOnly } = state;
  const rects = useMemo(() => displayRects(doc, gesture), [doc, gesture]);
  const lod: Lod = view.zoom < LOW_DETAIL_ZOOM ? 'low' : 'full';
  // Cull to the visible area plus half a screen around it.
  const visible = {
    x: -view.x / view.zoom - stageSize.width / view.zoom / 2,
    y: -view.y / view.zoom - stageSize.height / view.zoom / 2,
    width: (stageSize.width / view.zoom) * 2,
    height: (stageSize.height / view.zoom) * 2,
  };
  const single = selection.nodes.size === 1 && selection.edges.size === 0 && !gesture && !readOnly;
  // Handles and connection points only on nodes big enough on screen to still be grabbed by their body.
  const handlePx = isCoarsePointer() ? 30 : 14;
  const roomy = (r: Rect) => r.width * view.zoom >= handlePx * 3 && r.height * view.zoom >= handlePx * 2.5;
  const groups: ReactNode[] = [];
  const cards: ReactNode[] = [];
  for (const n of doc.nodes) {
    const r = rects.get(n.id)!;
    const selected = selection.nodes.has(n.id);
    if (!selected && editing !== n.id && !rectsIntersect(r, visible)) continue;
    const el = (
      <NodeView
        key={n.id}
        node={n}
        rect={r}
        selected={selected}
        editing={editing === n.id}
        handles={single && selected && roomy(r)}
        connectable={!readOnly && hover === n.id && !gesture && roomy(r)}
        target={gesture?.kind === 'connect' && gesture.target === n.id}
        lod={lod}
        env={env}
        controller={controller}
      />
    );
    (n.type === 'group' ? groups : cards).push(el);
  }
  const edges: ReactNode[] = [];
  const labels: ReactNode[] = [];
  for (const e of doc.edges) {
    const from = rects.get(e.fromNode);
    const to = rects.get(e.toNode);
    if (!from || !to) continue;
    const box = boundsOf([from, to])!;
    if (!rectsIntersect(box, visible)) continue;
    const selected = selection.edges.has(e.id);
    edges.push(<EdgeView key={e.id} edge={e} from={from} to={to} selected={selected} />);
    if (e.label) labels.push(<EdgeLabel key={e.id} edge={e} from={from} to={to} selected={selected} />);
  }
  const style = {
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`,
    '--inv-zoom': String(1 / view.zoom),
  } as CSSProperties;
  return (
    <div className={`canvas-world${lod === 'low' ? ' is-low-detail' : ''}`} style={style}>
      {groups}
      <svg className="canvas-edges" width="1" height="1" aria-hidden>
        {edges}
        <ConnectPreview doc={doc} gesture={gesture} rects={rects} />
      </svg>
      {cards}
      {labels}
      {gesture?.kind === 'marquee' && (
        <div className="canvas-marquee" style={{ left: gesture.rect.x, top: gesture.rect.y, width: gesture.rect.width, height: gesture.rect.height }} />
      )}
    </div>
  );
}

function ConnectPreview({ doc, gesture, rects }: { doc: CanvasDoc; gesture: Gesture | null; rects: Map<string, Rect> }) {
  if (gesture?.kind !== 'connect') return null;
  const from = rects.get(gesture.from);
  if (!from) return null;
  const target = gesture.target ? doc.nodes.find((n) => n.id === gesture.target) : undefined;
  const g = target
    ? edgeGeometry(from, gesture.side, rects.get(target.id)!, sideToward(rects.get(target.id)!, sideAnchor(from, gesture.side)))
    : danglingGeometry(from, gesture.side, gesture.to);
  return <path className="canvas-edge-line is-preview" d={g.d} />;
}

// ---------- floating UI ----------

function IconButton({ label, onClick, children, disabled, active, className }: { label: string; onClick(): void; children: ReactNode; disabled?: boolean; active?: boolean; className?: string }) {
  return (
    <button type="button" className={`canvas-tool${active ? ' is-active' : ''}${className ? ' ' + className : ''}`} aria-label={label} title={label} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  );
}

function Toolbar(props: {
  controller: CanvasController;
  readOnly: boolean;
  zoom: number;
  canUndo: boolean;
  canRedo: boolean;
  onAddCard(): void;
  onAddFile(): void;
  onAddMedia(): void;
  onAddLink(): void;
}) {
  const { controller: c, readOnly } = props;
  return (
    <div className="canvas-toolbar canvas-ui" role="toolbar" aria-label="Canvas tools">
      {!readOnly && (
        <>
          <IconButton label="Add card" onClick={props.onAddCard}>
            <StickyNote size={18} />
          </IconButton>
          <IconButton label="Add note or file from the vault" onClick={props.onAddFile}>
            <FilePlus size={18} />
          </IconButton>
          <IconButton label="Add image or media" onClick={props.onAddMedia}>
            <Image size={18} />
          </IconButton>
          <IconButton label="Add web page" onClick={props.onAddLink}>
            <Globe size={18} />
          </IconButton>
          <span className="canvas-toolbar-sep" />
          <IconButton label="Undo" onClick={() => c.undo()} disabled={!props.canUndo}>
            <Undo2 size={18} />
          </IconButton>
          <IconButton label="Redo" onClick={() => c.redo()} disabled={!props.canRedo}>
            <Redo2 size={18} />
          </IconButton>
          <span className="canvas-toolbar-sep" />
        </>
      )}
      <IconButton label="Zoom out" onClick={() => c.zoomBy(0.8)} className="is-zoom-step">
        <ZoomOut size={18} />
      </IconButton>
      <button
        type="button"
        className="canvas-tool canvas-zoom-level is-zoom-step"
        title="Reset zoom to 100%"
        aria-label={`Zoom ${Math.round(props.zoom * 100)}%, reset to 100%`}
        onClick={() => c.zoomAt(1 / c.getState().view.zoom, { x: c.stageSize.width / 2, y: c.stageSize.height / 2 })}
      >
        {Math.round(props.zoom * 100)}%
      </button>
      <IconButton label="Zoom in" onClick={() => c.zoomBy(1.25)} className="is-zoom-step">
        <ZoomIn size={18} />
      </IconButton>
      <IconButton label="Zoom to fit" onClick={() => c.zoomToFit()}>
        <Maximize size={18} />
      </IconButton>
    </div>
  );
}

function SelectionBar({
  state,
  controller: c,
  colorsOpen,
  setColorsOpen,
  onEdit,
}: {
  state: ReturnType<CanvasController['getState']>;
  controller: CanvasController;
  colorsOpen: boolean;
  setColorsOpen(open: boolean): void;
  onEdit(id: string): void;
}) {
  const { doc, selection, gesture, editing, readOnly, view } = state;
  if (!doc || gesture || editing || readOnly || (selection.nodes.size === 0 && selection.edges.size === 0)) return null;
  const nodes = doc.nodes.filter((n) => selection.nodes.has(n.id));
  const edges = doc.edges.filter((e) => selection.edges.has(e.id));
  const rects: Rect[] = nodes.map(nodeRect);
  for (const e of edges) {
    const from = doc.nodes.find((n) => n.id === e.fromNode);
    const to = doc.nodes.find((n) => n.id === e.toNode);
    if (from && to) {
      const g = edgeGeometry(nodeRect(from), isSide(e.fromSide) ? e.fromSide : undefined, nodeRect(to), isSide(e.toSide) ? e.toSide : undefined);
      rects.push({ x: g.mid.x - 1, y: g.mid.y - 1, width: 2, height: 2 });
    }
  }
  const b = boundsOf(rects);
  if (!b) return null;
  const stageWidth = c.stageSize.width;
  const left = Math.min(Math.max((b.x + b.width / 2) * view.zoom + view.x, 140), Math.max(140, stageWidth - 140));
  const top = Math.max(56, b.y * view.zoom + view.y - 12);
  const pick = (color: string | undefined) => {
    c.setColor(color);
    setColorsOpen(false);
  };
  const one = nodes.length === 1 && edges.length === 0 ? nodes[0] : null;
  const edge = edges.length === 1 && nodes.length === 0 ? edges[0] : null;
  const current = one?.color ?? edge?.color;
  return (
    <div className="canvas-selection-bar canvas-ui" style={{ left, top }} role="toolbar" aria-label="Selection">
      <IconButton label="Colour" onClick={() => setColorsOpen(!colorsOpen)} active={colorsOpen}>
        <Palette size={17} />
      </IconButton>
      {one?.type === 'text' && (
        <IconButton label="Edit card" onClick={() => onEdit(one.id)}>
          <Pencil size={17} />
        </IconButton>
      )}
      {one?.type === 'file' && (
        <IconButton label="Open file" onClick={() => openFileNode(one)}>
          <ExternalLink size={17} />
        </IconButton>
      )}
      {one?.type === 'link' && (
        <IconButton label="Open link" onClick={() => openLinkNode(one)}>
          <ExternalLink size={17} />
        </IconButton>
      )}
      {one?.type === 'group' && (
        <IconButton label="Rename group" onClick={() => void promptGroupLabel(c, one.id)}>
          <TextCursorInput size={17} />
        </IconButton>
      )}
      {edge && (
        <>
          <IconButton label="Edit label" onClick={() => void promptEdgeLabel(c, edge.id)}>
            <Tag size={17} />
          </IconButton>
          <IconButton label="Arrow direction" onClick={() => c.updateEdge(edge.id, cycleArrows(edge))}>
            {edgeFromEnd(edge) === 'arrow' && edgeToEnd(edge) === 'arrow' ? <ArrowLeftRight size={17} /> : <MoveRight size={17} />}
          </IconButton>
        </>
      )}
      {nodes.length > 0 && (
        <IconButton label="Group" onClick={() => c.groupSelection()}>
          <Group size={17} />
        </IconButton>
      )}
      {nodes.length > 0 && (
        <IconButton label="Zoom to selection" onClick={() => c.zoomToSelection()}>
          <Focus size={17} />
        </IconButton>
      )}
      <IconButton label="Delete" onClick={() => c.deleteSelection()}>
        <Trash2 size={17} />
      </IconButton>
      {colorsOpen && (
        <div className={`canvas-colors${top > 140 ? ' is-above' : ''}`} role="group" aria-label="Colours">
          <button type="button" className={`canvas-swatch is-none${!current ? ' is-current' : ''}`} aria-label="No colour" title="No colour" onClick={() => pick(undefined)} />
          {Object.entries(PRESET_COLORS).map(([key, { name, value }]) => (
            <button
              key={key}
              type="button"
              className={`canvas-swatch${current === key ? ' is-current' : ''}`}
              style={{ background: value }}
              aria-label={name}
              title={name}
              onClick={() => pick(key)}
            />
          ))}
          <label className="canvas-swatch is-custom" title="Custom colour">
            <input
              type="color"
              aria-label="Custom colour"
              value={cssColor(current)?.length === 7 ? cssColor(current)! : '#888888'}
              onChange={(e) => c.setColor(e.target.value)}
            />
          </label>
        </div>
      )}
    </div>
  );
}

/** One arrow → both arrows → no arrows → one arrow. */
function cycleArrows(edge: CanvasDoc['edges'][number]): Partial<Record<string, unknown>> {
  const from = edgeFromEnd(edge);
  const to = edgeToEnd(edge);
  if (from === 'none' && to === 'arrow') return { fromEnd: 'arrow', toEnd: undefined };
  if (from === 'arrow' && to === 'arrow') return { fromEnd: undefined, toEnd: 'none' };
  return { fromEnd: undefined, toEnd: undefined };
}

interface MenuActions {
  edit(id: string): void;
  addCard(at: Point): void;
  addFile(at: Point): void;
  addMedia(at: Point): void;
  pasteText(text: string, at?: Point): void;
}

function menuItems(req: MenuRequest, c: CanvasController, a: MenuActions): MenuEntry[] {
  const state = c.getState();
  const readOnly = state.readOnly;
  const doc = state.doc;
  if (!doc) return [];
  if (req.kind === 'background') {
    const items: MenuEntry[] = [];
    if (!readOnly) {
      items.push(
        { id: 'add-card', label: 'Add card here', icon: <StickyNote size={15} />, run: () => a.addCard(req.world) },
        { id: 'add-file', label: 'Add note or file…', icon: <FilePlus size={15} />, run: () => a.addFile(req.world) },
        { id: 'add-media', label: 'Add image or media…', icon: <Image size={15} />, run: () => a.addMedia(req.world) },
        { id: 'add-link', label: 'Add web page…', icon: <Globe size={15} />, run: () => void promptLink(c, req.world) },
        {
          id: 'paste',
          label: 'Paste',
          icon: <ClipboardPaste size={15} />,
          run: () => {
            const own = CanvasController.pageClipboard();
            if (navigator.clipboard?.readText) {
              navigator.clipboard.readText().then(
                (text) => a.pasteText(text, req.world),
                () => own && a.pasteText(own.text, req.world),
              );
            } else if (own) a.pasteText(own.text, req.world);
            else toast('Nothing to paste', { kind: 'error' });
          },
        },
        'separator',
      );
    }
    items.push(
      { id: 'select-all', label: 'Select all', run: () => c.selectAll() },
      { id: 'fit', label: 'Zoom to fit', icon: <Maximize size={15} />, run: () => c.zoomToFit() },
    );
    return items;
  }
  if (req.kind === 'edge') {
    const edge = doc.edges.find((e) => e.id === req.id);
    if (!edge) return [];
    if (readOnly) return [{ id: 'fit', label: 'Zoom to fit', run: () => c.zoomToFit() }];
    return [
      { id: 'label', label: 'Edit label…', icon: <Tag size={15} />, run: () => void promptEdgeLabel(c, edge.id) },
      {
        id: 'start',
        label: edgeFromEnd(edge) === 'arrow' ? 'Remove arrow at start' : 'Add arrow at start',
        run: () => c.updateEdge(edge.id, { fromEnd: edgeFromEnd(edge) === 'arrow' ? undefined : 'arrow' }),
      },
      {
        id: 'end',
        label: edgeToEnd(edge) === 'arrow' ? 'Remove arrow at end' : 'Add arrow at end',
        run: () => c.updateEdge(edge.id, { toEnd: edgeToEnd(edge) === 'arrow' ? 'none' : undefined }),
      },
      {
        id: 'reverse',
        label: 'Reverse direction',
        icon: <ArrowLeftRight size={15} />,
        run: () =>
          c.updateEdge(edge.id, {
            fromNode: edge.toNode,
            toNode: edge.fromNode,
            fromSide: edge.toSide,
            toSide: edge.fromSide,
          }),
      },
      'separator',
      { id: 'delete', label: 'Delete', icon: <Trash2 size={15} />, danger: true, run: () => c.deleteSelection() },
    ];
  }
  const node = doc.nodes.find((n) => n.id === req.id);
  if (!node) return [];
  const many = state.selection.nodes.size > 1;
  const items: MenuEntry[] = [];
  if (!many) {
    if (node.type === 'text' && !readOnly) {
      items.push({ id: 'edit', label: 'Edit', icon: <Pencil size={15} />, run: () => a.edit(node.id) });
      items.push({ id: 'convert', label: 'Convert to note…', icon: <FileOutput size={15} />, run: () => void convertToNote(c, node.id) });
    }
    if (node.type === 'file') items.push({ id: 'open', label: 'Open file', icon: <ExternalLink size={15} />, run: () => openFileNode(node) });
    if (node.type === 'link') items.push({ id: 'open', label: 'Open link', icon: <ExternalLink size={15} />, run: () => openLinkNode(node) });
    if (node.type === 'group' && !readOnly) items.push({ id: 'rename', label: 'Rename group…', icon: <TextCursorInput size={15} />, run: () => void promptGroupLabel(c, node.id) });
    if (items.length) items.push('separator');
  }
  const copy = () => {
    const text = c.copySelection();
    if (text) void navigator.clipboard?.writeText(text).catch(() => undefined);
  };
  items.push({ id: 'copy', label: 'Copy', icon: <Copy size={15} />, run: copy });
  if (!readOnly) {
    items.push(
      {
        id: 'cut',
        label: 'Cut',
        icon: <Scissors size={15} />,
        run: () => {
          copy();
          c.deleteSelection();
        },
      },
      { id: 'duplicate', label: 'Duplicate', icon: <CopyPlus size={15} />, run: () => c.duplicateSelection() },
      { id: 'front', label: 'Bring to front', icon: <BringToFront size={15} />, run: () => c.reorder('front') },
      { id: 'back', label: 'Send to back', icon: <SendToBack size={15} />, run: () => c.reorder('back') },
      { id: 'group', label: 'Create group', icon: <Group size={15} />, run: () => c.groupSelection() },
    );
  }
  items.push({ id: 'zoom', label: 'Zoom to selection', icon: <Focus size={15} />, run: () => c.zoomToSelection() });
  if (!readOnly) items.push('separator', { id: 'delete', label: 'Delete', icon: <Trash2 size={15} />, danger: true, run: () => c.deleteSelection() });
  return items;
}

function FilePicker({ canvasPath, onPick, onClose }: { canvasPath: string; onPick(entry: FileEntry): void; onClose(): void }) {
  const tree = useTree().data;
  const [query, setQuery] = useState('');
  const files = useMemo(() => (tree ? tree.files.filter((f) => f.path !== canvasPath) : []), [tree, canvasPath]);
  const items = useMemo(() => {
    if (query.trim() === '') {
      // Notes near the canvas first, then everything else by recency.
      const folder = folderOf(canvasPath);
      return [...files].sort((a, b) => Number(folderOf(b.path) === folder) - Number(folderOf(a.path) === folder) || b.mtime.localeCompare(a.mtime)).slice(0, 50);
    }
    return fuzzyRank(query, files, [(f) => f.path], 50).map((r) => r.item);
  }, [files, query, canvasPath]);
  return (
    <Picker
      label="Add note or file"
      placeholder="Find a note or file…"
      query={query}
      onQuery={setQuery}
      items={items}
      itemKey={(f) => f.path}
      renderItem={(f) => (
        <span className="picker-item-text">
          <span className="picker-item-label">{displayName(f.path)}</span>
          {folderOf(f.path) && <span className="picker-item-detail">{folderOf(f.path)}</span>}
        </span>
      )}
      onPick={(f) => {
        onClose();
        onPick(f);
      }}
      onClose={onClose}
      empty="No matching files"
    />
  );
}
