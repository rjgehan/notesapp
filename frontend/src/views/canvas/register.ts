// Registers the canvas view (ROADMAP item 25) through the view registry (DESIGN §6.8). Only this
// small module is in the main bundle; the view, its embed and the JSON Canvas code are lazy chunks.
import { Group, LayoutDashboard, Maximize } from 'lucide-react';
import type { Command } from '../../features/commands';
import { registerView } from '../registry';
import { activeCanvas } from './active';

/** A new canvas, as Obsidian writes an empty one. */
export const NEW_CANVAS_TEXT = '{\n\t"nodes":[],\n\t"edges":[]\n}';

type Merge = (base: string, mine: string, theirs: string) => string | null;

let mergeImpl: Merge | null = null;

/**
 * Installed by the view's chunk when it loads. A conflict is shown (and Compare offered) only
 * while the canvas is open, so the merge is always there when it is asked for.
 */
export function setCanvasMerge(fn: Merge): void {
  mergeImpl = fn;
}

function canvasCommand(id: string, name: string, run: (c: NonNullable<ReturnType<typeof activeCanvas>>) => void, icon?: Command['icon']): Command {
  return {
    id: `canvas.${id}`,
    name: `Canvas: ${name}`,
    icon,
    when: (ctx) => activeCanvas(ctx.activePath) !== null,
    run: (ctx) => {
      const c = activeCanvas(ctx.activePath);
      if (c) run(c);
    },
  };
}

export function registerCanvasView(): void {
  registerView({
    id: 'canvas',
    match: (e) => (e.path.toLowerCase().endsWith('.canvas') ? 7 : 0),
    icon: LayoutDashboard,
    textual: true,
    modes: ['edit'],
    load: () => import('./CanvasView'),
    loadEmbed: () => import('./CanvasEmbed'),
    create: { label: 'canvas', extension: 'canvas', initialContent: () => NEW_CANVAS_TEXT },
    merge: (base, mine, theirs) => (mergeImpl ? mergeImpl(base, mine, theirs) : null),
    commands: [
      canvasCommand('addCard', 'Add card', (c) => c.addCard()),
      canvasCommand('addFile', 'Add note or file…', (c) => c.addFile()),
      canvasCommand('addMedia', 'Add image or media…', (c) => c.addMedia()),
      canvasCommand('addLink', 'Add web page…', (c) => c.addLink()),
      canvasCommand('group', 'Group selection', (c) => c.groupSelection(), Group),
      canvasCommand('fit', 'Zoom to fit', (c) => c.zoomToFit(), Maximize),
      canvasCommand('zoomSelection', 'Zoom to selection', (c) => c.zoomToSelection()),
      canvasCommand('undo', 'Undo', (c) => c.undo()),
      canvasCommand('redo', 'Redo', (c) => c.redo()),
    ],
  });
}
