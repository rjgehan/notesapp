// Rich Markdown pack (ROADMAP item 3): Obsidian callouts, highlighted code, KaTeX math and Mermaid
// diagrams. This module is the public API; the heavy parts (KaTeX, Mermaid, grammars) are separate
// chunks loaded on first use.
//
// The reading view (render.ts) installs `richMarkdown` into markdown-it and calls `hydrateRich()`
// after every patch. Live Preview (ROADMAP item 10) and other callers can use the renderers
// directly; all of them produce the same markup, styled by styles/rich.css:
//
//   parseCalloutHeader('[!faq]- Why?')   → { type: 'faq', kind: 'question', fold: '-', title: 'Why?', metadata: null }
//   renderCallout(header, title?, body?) → <div|details class="callout" data-callout="faq">…</…>
//   renderMath(el, tex, displayMode)     → KaTeX into `el` (trust off, sanitized); synchronous once KaTeX is loaded
//   renderMermaid(el, source)            → SVG into `el` (strict, sanitized), errors shown inline, re-rendered on theme change
//   highlightCode(code, lang)            → Promise<DocumentFragment | null> of `cm-tok-*` spans (null: unknown language)
//   highlightCodeSync(code, lang)        → the same, or null while the grammar is not loaded yet
//   preloadRich({math, mermaid, code})   → starts loading chunks ahead of use
//
// Every renderer fills the element it is given and never parses note text as HTML.
import '../../styles/rich.css';

export { CALLOUT_KINDS, defaultCalloutTitle, parseCalloutHeader, renderCallout, type CalloutHeader, type CalloutKind } from './callouts';
export { richMarkdown, type RichMarkdownOptions } from './markdown';

// ---------- lazy modules ----------

interface LazyModule<M> {
  /** The module once loaded, for synchronous use. */
  get(): M | null;
  load(): Promise<M>;
}

function lazyModule<M>(importer: () => Promise<M>): LazyModule<M> {
  let module: M | null = null;
  let promise: Promise<M> | null = null;
  return {
    get: () => module,
    load: () =>
      (promise ??= importer().then(
        (m) => (module = m),
        (e: unknown) => {
          // Retry on the next use (a chunk can fail to load while offline).
          promise = null;
          throw e;
        },
      )),
  };
}

const katex = lazyModule(() => import('./katex'));
const mermaid = lazyModule(() => import('./mermaid'));
const highlight = lazyModule(() => import('./highlight'));

function warn(what: string): (e: unknown) => void {
  return (e) => console.warn(`[rich] ${what} failed`, e);
}

export function preloadRich(which: { math?: boolean; mermaid?: boolean; code?: boolean }): void {
  if (which.math) katex.load().catch(warn('loading KaTeX'));
  if (which.mermaid) mermaid.load().catch(warn('loading Mermaid'));
  if (which.code) highlight.load().catch(warn('loading the highlighter'));
}

// ---------- math ----------

/** Renders TeX into `target`, replacing its children. Synchronous (the promise is already settled) once KaTeX is loaded. */
export function renderMath(target: HTMLElement, tex: string, displayMode: boolean): Promise<void> {
  const draw = (m: typeof import('./katex')) => {
    m.renderMathInto(target, tex, displayMode);
    target.classList.add('is-rendered');
  };
  const loaded = katex.get();
  if (loaded) {
    draw(loaded);
    return Promise.resolve();
  }
  return katex.load().then(draw);
}

// ---------- code ----------

/** Highlighted code if the language's grammar is already loaded, else null (see highlightCode). */
export function highlightCodeSync(code: string, lang: string): DocumentFragment | null {
  const m = highlight.get();
  const language = m?.loadedLanguage(lang);
  return m && language ? m.highlightFragment(code, language) : null;
}

/** Highlighted code, loading the highlighter and the grammar as needed; null for an unknown language. */
export async function highlightCode(code: string, lang: string): Promise<DocumentFragment | null> {
  const m = await highlight.load();
  const language = await m.loadLanguage(lang);
  return language ? m.highlightFragment(code, language) : null;
}

function addCopyButton(pre: HTMLElement, code: HTMLElement): void {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'code-copy';
  button.title = 'Copy';
  button.setAttribute('aria-label', 'Copy code');
  button.addEventListener('click', (e) => {
    e.preventDefault();
    const text = (code.textContent ?? '').replace(/\n$/, '');
    navigator.clipboard?.writeText(text).then(
      () => {
        button.classList.add('is-copied');
        setTimeout(() => button.classList.remove('is-copied'), 1500);
      },
      warn('copying code'),
    );
  });
  pre.appendChild(button);
}

function hydrateCode(pre: HTMLElement): void {
  const code = pre.querySelector<HTMLElement>(':scope > code');
  if (!code) return;
  addCopyButton(pre, code);
  const lang = pre.dataset.lang;
  if (!lang) return;
  const source = code.textContent ?? '';
  const apply = (fragment: DocumentFragment | null) => {
    if (!fragment || code.textContent !== source) return;
    code.replaceChildren(fragment);
    pre.classList.add('is-highlighted');
  };
  const sync = highlightCodeSync(source, lang);
  if (sync) apply(sync);
  else highlightCode(source, lang).then(apply, warn('highlighting code'));
}

// ---------- mermaid ----------

type Theme = 'dark' | 'light';

const currentTheme = (): Theme => (document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

interface DiagramState {
  source: string;
  generation: number;
}

const diagrams = new WeakMap<HTMLElement, DiagramState>();
/** Diagrams to re-render when the theme changes (pruned of disconnected elements as it goes). */
const liveDiagrams = new Set<HTMLElement>();
let themeObserver: MutationObserver | null = null;

function pruneDiagrams(): void {
  for (const el of liveDiagrams) if (!el.isConnected) liveDiagrams.delete(el);
}

function observeTheme(): void {
  if (themeObserver || typeof MutationObserver === 'undefined') return;
  themeObserver = new MutationObserver(() => {
    pruneDiagrams();
    const theme = currentTheme();
    for (const el of liveDiagrams) if (el.dataset.renderedTheme !== theme) void drawDiagram(el);
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

function child(target: HTMLElement, className: string, before?: Element | null): HTMLElement {
  let el = target.querySelector<HTMLElement>(`:scope > .${className}`);
  if (!el) {
    el = document.createElement('div');
    el.className = className;
    target.insertBefore(el, before ?? null);
  }
  return el;
}

/** Wide diagrams shrink to the column only down to this scale, then scroll sideways (phones). */
const MIN_DIAGRAM_SCALE = 0.6;

function showDiagram(target: HTMLElement, svg: DocumentFragment, theme: Theme): void {
  target.querySelector(':scope > .mermaid-error')?.remove();
  // Mermaid sizes the SVG `width: 100%` with its natural width as `max-width`.
  const natural = parseFloat(svg.querySelector('svg')?.style.maxWidth ?? '');
  if (natural > 0) svg.querySelector('svg')!.style.minWidth = `${Math.round(natural * MIN_DIAGRAM_SCALE)}px`;
  child(target, 'mermaid-svg', target.firstElementChild).replaceChildren(svg);
  target.dataset.renderedTheme = theme;
  target.classList.remove('has-error', 'is-loading');
  target.classList.add('is-rendered');
}

function showDiagramError(target: HTMLElement, error: unknown, theme: Theme): void {
  target.querySelector(':scope > .mermaid-svg')?.remove();
  const message = (error instanceof Error ? error.message : String(error)).trim() || 'Unknown error';
  const box = child(target, 'mermaid-error', target.firstElementChild);
  box.setAttribute('role', 'note');
  box.textContent = `Mermaid: ${message}`;
  target.dataset.renderedTheme = theme;
  target.classList.remove('is-rendered', 'is-loading');
  target.classList.add('has-error');
}

async function drawDiagram(target: HTMLElement): Promise<void> {
  const state = diagrams.get(target);
  if (!state) return;
  const generation = ++state.generation;
  const theme = currentTheme();
  const cached = mermaid.get()?.cachedDiagram(state.source, theme);
  if (cached) {
    showDiagram(target, cached, theme);
    return;
  }
  target.classList.add('is-loading');
  try {
    const m = await mermaid.load();
    const svg = await m.renderDiagram(state.source, theme);
    if (state.generation === generation) showDiagram(target, svg, theme);
  } catch (e) {
    if (state.generation === generation) showDiagramError(target, e, theme);
  }
}

/**
 * Renders a Mermaid diagram into `target` (adds a `.mermaid-svg` or `.mermaid-error` child, keeps
 * other children). The diagram follows the app theme while `target` stays in the document.
 */
export function renderMermaid(target: HTMLElement, source: string): Promise<void> {
  target.classList.add('mermaid-block');
  const state = diagrams.get(target);
  if (state) state.source = source;
  else diagrams.set(target, { source, generation: 0 });
  liveDiagrams.add(target);
  observeTheme();
  return drawDiagram(target);
}

// ---------- hydration ----------

const hydrated = new WeakSet<Element>();

/**
 * Fills the renderer's placeholders under `root` (math, Mermaid, code blocks). Idempotent: an
 * element is hydrated once, so blocks kept by the per-block patch keep their rendering and are
 * never rendered again. Uses the loaded modules synchronously, so a re-inserted block (an edit
 * inside it) shows highlighted code and math without a flash.
 */
export function hydrateRich(root: ParentNode): void {
  pruneDiagrams();
  for (const el of root.querySelectorAll<HTMLElement>('[data-math], [data-mermaid], pre.code-block')) {
    if (hydrated.has(el)) continue;
    hydrated.add(el);
    if (el.hasAttribute('data-math')) {
      renderMath(el, el.textContent ?? '', el.dataset.math !== 'inline').catch(warn('rendering math'));
    } else if (el.hasAttribute('data-mermaid')) {
      void renderMermaid(el, el.querySelector('.mermaid-source')?.textContent ?? '');
    } else {
      hydrateCode(el);
    }
  }
}
