// Where the always-loaded code finds the editor's commands (kit.ts, in the editor's chunk).
import type { EditorKit } from './kit';

let kit: EditorKit | null = null;

export function provideEditorKit(k: EditorKit): void {
  kit = k;
}

/** The editor's commands, once an editor's chunk has loaded them (every editor imports kit.ts); null before. */
export function editorKit(): EditorKit | null {
  return kit;
}

/** The editor's commands, loading them first when no editor has yet. */
export function loadEditorKit(): Promise<EditorKit> {
  return kit ? Promise.resolve(kit) : import('./kit').then((m) => m.editorKit);
}
