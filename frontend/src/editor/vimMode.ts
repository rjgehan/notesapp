// Vim mode (ROADMAP item 36, DESIGN §6.36): the small, always-loaded half. The keys themselves
// (`@replit/codemirror-vim`, 122 kB minified) are a lazy chunk, `./vim`, loaded the first time an
// editor mounts with the preference on; until then the editor's compartment is empty.
import { Compartment, Facet, type Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { useSyncExternalStore } from 'react';
import { isCoarsePointer } from '../features/platform';

/** An editor key that runs an app command (`Mod-b` bold, `Mod-s` save, …), by command id. */
export interface CommandKey {
  key: string;
  id: string;
  run(view: EditorView): boolean;
  preventDefault?: boolean;
}

/**
 * The editor's command keys. Vim runs before CodeMirror's keymaps, so the vim extension runs these
 * first itself: the app's keys keep working in every vim mode, and a key whose command was given
 * another key on this device (Settings, Hotkeys) goes to vim.
 */
export const editorCommandKeys = Facet.define<readonly CommandKey[], readonly CommandKey[]>({
  combine: (values) => values.flat(),
});

/** Holds the vim extension in every editor; empty while vim is off or still loading. */
export const vimCompartment = new Compartment();

/**
 * Vim is used when this device asks for it and its primary pointer is fine (a mouse or a
 * trackpad). On a touch screen normal mode would swallow what the on-screen keyboard types.
 */
export function vimAvailable(): boolean {
  return !isCoarsePointer();
}

export function vimWanted(pref: boolean): boolean {
  return pref && vimAvailable();
}

let loaded: Extension | null = null;
let loading: Promise<Extension> | null = null;

/** The vim extension once its chunk has loaded (so a later mount applies it synchronously). */
export function loadedVim(): Extension | null {
  return loaded;
}

export function loadVim(): Promise<Extension> {
  loading ??= import('./vim').then(
    (m) => (loaded = m.vimExtension()),
    (e: unknown) => {
      loading = null;
      throw e;
    },
  );
  return loading;
}

/** The compartment's initial content for an editor: vim if wanted and already loaded. */
export function vimSlot(enabled: boolean): Extension {
  return vimCompartment.of(enabled ? (loaded ?? []) : []);
}

/**
 * Loads vim if this editor wants it and it is not loaded yet, then puts it in the editor's
 * compartment, unless the editor was destroyed meanwhile.
 */
export function attachVim(view: EditorView, enabled: boolean): void {
  if (!enabled || loaded) return;
  loadVim().then(
    (ext) => {
      if (view.dom.isConnected) view.dispatch({ effects: vimCompartment.reconfigure(ext) });
    },
    (e: unknown) => console.warn('Vim mode could not be loaded', e),
  );
}

// ---------- the mode shown in the status bar ----------

export type VimModeLabel = 'NORMAL' | 'INSERT' | 'VISUAL' | 'VISUAL LINE' | 'VISUAL BLOCK' | 'REPLACE';

let current: { view: EditorView; mode: VimModeLabel } | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Called by the vim chunk when an editor's mode changes (or it gets focus). */
export function publishVimMode(view: EditorView, mode: VimModeLabel): void {
  if (current?.view === view && current.mode === mode) return;
  current = { view, mode };
  emit();
}

/** Called by the vim chunk when an editor loses vim (destroyed, or vim turned off). */
export function clearVimMode(view: EditorView): void {
  if (current?.view !== view) return;
  current = null;
  emit();
}

export function vimModeLabel(mode: string | undefined, subMode?: string): VimModeLabel {
  switch (mode) {
    case 'insert':
      return 'INSERT';
    case 'replace':
      return 'REPLACE';
    case 'visual':
      return subMode === 'linewise' ? 'VISUAL LINE' : subMode === 'blockwise' ? 'VISUAL BLOCK' : 'VISUAL';
    default:
      return 'NORMAL';
  }
}

export function currentVimMode(): VimModeLabel | null {
  return current?.mode ?? null;
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The vim mode of the editor that last had it, or null without a vim editor. */
export function useVimMode(): VimModeLabel | null {
  return useSyncExternalStore(subscribe, currentVimMode);
}
