// A new drawing's text (DESIGN §6.8.1), apart from format.ts so the always-loaded descriptor
// (register.ts) can create drawings without the format's parser and diff.
import type { Scene } from './format';

export const EXCALIDRAW_SOURCE = 'https://github.com/rjgehan/notesapp';

/** The content of a new `.excalidraw` file. */
export function newDrawingContent(): string {
  const scene: Scene = {
    type: 'excalidraw',
    version: 2,
    source: EXCALIDRAW_SOURCE,
    elements: [],
    appState: { gridSize: 20, gridStep: 5, gridModeEnabled: false, viewBackgroundColor: '#ffffff' },
    files: {},
  };
  return JSON.stringify(scene, null, 2);
}
