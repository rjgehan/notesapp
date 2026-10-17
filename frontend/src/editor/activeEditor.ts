// The editor of the open note, for palette commands and the mobile toolbar.
import type { EditorView } from '@codemirror/view';

let active: EditorView | null = null;

export function setActiveEditor(view: EditorView | null): void {
  active = view;
}

export function clearActiveEditor(view: EditorView): void {
  if (active === view) active = null;
}

export function activeEditor(): EditorView | null {
  return active;
}
