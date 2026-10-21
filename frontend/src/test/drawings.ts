// Test fixtures for drawings: elements, scenes, and Obsidian Excalidraw Markdown files as the
// plugin writes them (frontmatter, Text Elements, Element Links, Embedded Files, a %%-wrapped
// Drawing block).
import { compressDrawing, type Scene, type SceneElement } from '../views/excalidraw/format';

let nonce = 1000;

export function el(id: string, extra: Partial<SceneElement> = {}): SceneElement {
  return { id, type: 'rectangle', version: 1, versionNonce: nonce++, isDeleted: false, x: 0, y: 0, width: 10, height: 10, ...extra };
}

export function text(id: string, value: string, extra: Partial<SceneElement> = {}): SceneElement {
  return el(id, { type: 'text', text: value, originalText: value, fontSize: 20, ...extra });
}

export function scene(elements: SceneElement[], extra: Partial<Scene> = {}): Scene {
  return { type: 'excalidraw', version: 2, source: 'https://excalidraw.com', elements, appState: { gridSize: 20, viewBackgroundColor: '#ffffff' }, files: {}, ...extra };
}

export const PLUGIN_HEAD = `---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'


# Excalidraw Data

`;

export interface MarkdownFixture {
  texts?: Array<[string, string]>;
  links?: Array<[string, string]>;
  embedded?: Array<[string, string]>;
  scene: Scene;
  compressed?: boolean;
  head?: string;
  tail?: string;
}

/** An `.excalidraw.md` file in the plugin's layout. */
export function markdownDrawing({ texts = [], links = [], embedded = [], scene: s, compressed = false, head = PLUGIN_HEAD, tail = '' }: MarkdownFixture): string {
  const json = JSON.stringify(s, null, '\t');
  return (
    head +
    '## Text Elements\n' +
    texts.map(([id, raw]) => `${raw} ^${id}\n\n`).join('') +
    (links.length ? '## Element Links\n' + links.map(([id, v]) => `${id}: ${v}\n\n`).join('') : '') +
    (embedded.length ? '## Embedded Files\n' + embedded.map(([id, v]) => `${id}: ${v}\n\n`).join('') : '') +
    '%%\n## Drawing\n```' +
    (compressed ? 'compressed-json' : 'json') +
    '\n' +
    (compressed ? compressDrawing(json) : json) +
    '\n```\n%%' +
    tail
  );
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

/**
 * A crafted lz-string base64 block: the character "a", then `steps` codes that each name the next
 * dictionary slot (lz-string's "KwKwK" case), so that it decodes to 1 + 2 + … + (steps + 1)
 * characters: 6000 steps are 13 KB that expand to 18 million.
 */
export function lzBomb(steps: number): string {
  const bits: number[] = [];
  const put = (value: number, count: number) => {
    for (let i = 0; i < count; i++) bits.push((value >> i) & 1);
  };
  put(0, 2);
  put('a'.charCodeAt(0), 8);
  let size = 4;
  let numBits = 3;
  let enlargeIn = 4;
  for (let s = 0; s < steps; s++) {
    put(size++, numBits);
    if (--enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }
  }
  put(2, numBits);
  let out = '';
  for (let i = 0; i < bits.length; i += 6) {
    let v = 0;
    for (let j = 0; j < 6; j++) v = (v << 1) | (bits[i + j] ?? 0);
    out += BASE64[v];
  }
  return out;
}
