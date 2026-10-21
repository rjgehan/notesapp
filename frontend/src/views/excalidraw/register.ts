// Drawings (ROADMAP item 5, DESIGN §6.8.1), registered through the view registry like every
// built-in view: `.excalidraw` (score 11) with "New drawing", and Obsidian Excalidraw's
// `.excalidraw.md` (14, which beats `.md`). Both are textual, so autosave, drafts, conflicts,
// history and live sync come from the DocumentSession; `merge` reconciles elements. The editor
// and the `![[drawing]]` embed (exportToSvg) are lazy chunks; this module stays small.
import { Shapes } from 'lucide-react';
import { registerView } from '../registry';
import { newDrawingContent } from './format';
import { mergeDrawingTexts } from './merge';

/**
 * Excalidraw loads its fonts from here (window.EXCALIDRAW_ASSET_PATH): copied out of the package
 * by the build into a versioned folder under /assets/, which the server caches as immutable. The
 * CSP blocks Excalidraw's CDN fallback, and offline mode needs local fonts anyway.
 */
export const EXCALIDRAW_ASSET_PATH = import.meta.env.VITE_EXCALIDRAW_ASSETS;

export function registerDrawingViews(): void {
  if (typeof window !== 'undefined') window.EXCALIDRAW_ASSET_PATH = EXCALIDRAW_ASSET_PATH;
  registerView({
    id: 'excalidraw',
    match: (e) => (e.path.toLowerCase().endsWith('.excalidraw') ? 11 : 0),
    icon: Shapes,
    textual: true,
    modes: ['edit'],
    load: () => import('./ExcalidrawView'),
    loadEmbed: () => import('./DrawingEmbed'),
    create: { label: 'drawing', extension: 'excalidraw', initialContent: newDrawingContent },
    merge: (base, mine, theirs) => mergeDrawingTexts('excalidraw', base, mine, theirs),
  });
  registerView({
    id: 'excalidraw-md',
    match: (e) => (e.path.toLowerCase().endsWith('.excalidraw.md') ? 14 : 0),
    icon: Shapes,
    textual: true,
    modes: ['edit'],
    load: () => import('./ExcalidrawView'),
    loadEmbed: () => import('./DrawingEmbed'),
    merge: (base, mine, theirs) => mergeDrawingTexts('markdown', base, mine, theirs),
  });
}
