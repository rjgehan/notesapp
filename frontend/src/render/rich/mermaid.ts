// Mermaid, loaded lazily by rich/index.ts on the first diagram (its own chunks). securityLevel
// 'strict' (labels HTML-encoded, no click handlers or links), directives may not touch the
// security-relevant keys, and the SVG is sanitized again (sanitize.ts). Layout is dagre: Mermaid
// 12's default ELK layout pulls in elkjs, which is EPL-2.0 (not GPL-compatible) and 1.4 MB, so it
// is aliased to a stub in vite.config.ts and `layout` is a secure key. Excalidraw's Mermaid import
// shares this Mermaid, each with its own configuration (mermaidShared.ts).
import { appMermaid as mermaid } from './mermaidShared';
import { sanitizeSvg } from './sanitize';

export type DiagramTheme = 'dark' | 'light';

/** Keys a diagram's `%%{init}%%` directive or frontmatter `config:` cannot change. */
const SECURE_KEYS = ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'layout', 'themeCSS', 'dompurifyConfig'];

/** Mermaid's dark theme draws pie slices in near-black; these are the app's accent colours. */
const DARK_PIE = {
  pie1: '#a882ff',
  pie2: '#027aff',
  pie3: '#53dfdd',
  pie4: '#44cf6e',
  pie5: '#e9973f',
  pie6: '#fb464c',
  pie7: '#e0de71',
  pie8: '#9e9e9e',
  pie9: '#6b3fd8',
  pie10: '#0f8a87',
  pie11: '#b4543c',
  pie12: '#5c5c5c',
  pieSectionTextColor: '#1e1e1e',
  pieStrokeColor: '#1e1e1e',
  pieOuterStrokeColor: '#363636',
};

let initializedFor: DiagramTheme | null = null;

function initialize(theme: DiagramTheme): void {
  if (initializedFor === theme) return;
  const font = getComputedStyle(document.documentElement).getPropertyValue('--font-text').trim();
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: theme === 'dark' ? 'dark' : 'default',
    darkMode: theme === 'dark',
    themeVariables: theme === 'dark' ? DARK_PIE : {},
    ...(font ? { fontFamily: font } : {}),
    layout: 'dagre',
    suppressErrorRendering: true,
    maxTextSize: 50_000,
    maxEdges: 500,
    secure: SECURE_KEYS,
  });
  initializedFor = theme;
}

const CACHE_LIMIT = 50;
const cache = new Map<string, DocumentFragment>();
let counter = 0;

/** A cached rendering (a fresh copy), or null: lets a re-inserted diagram appear without a flash. */
export function cachedDiagram(source: string, theme: DiagramTheme): DocumentFragment | null {
  const fragment = cache.get(theme + '\n' + source);
  return fragment ? (fragment.cloneNode(true) as DocumentFragment) : null;
}

/** Renders a diagram to a sanitized SVG fragment. Throws Mermaid's parse or render error. */
export async function renderDiagram(source: string, theme: DiagramTheme): Promise<DocumentFragment> {
  const key = theme + '\n' + source;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.cloneNode(true) as DocumentFragment;
  }
  initialize(theme);
  const id = `mermaid-${(++counter).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const { svg } = await mermaid.render(id, source);
    const fragment = sanitizeSvg(svg);
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    cache.set(key, fragment);
    return fragment.cloneNode(true) as DocumentFragment;
  } finally {
    // Mermaid measures in a temporary element under <body>; make sure none is left behind.
    document.getElementById('d' + id)?.remove();
    document.getElementById(id)?.remove();
  }
}
