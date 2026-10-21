// KaTeX, loaded lazily by rich/index.ts on the first formula (its own chunk, with its CSS and
// bundled fonts served from 'self', so the CSP needs no change). `trust` stays off: no \href,
// \url, \includegraphics or \html* commands; the output is sanitized again (sanitize.ts).
import katex from 'katex';
import 'katex/contrib/mhchem';
import 'katex/dist/katex.min.css';
import { sanitizeMath } from './sanitize';

const OPTIONS = {
  throwOnError: false,
  trust: false,
  strict: 'ignore',
  output: 'htmlAndMathml',
  // Bounds against pathological input (huge \rule sizes, macro bombs).
  maxSize: 100,
  maxExpand: 1000,
} as const;

const CACHE_LIMIT = 500;
const cache = new Map<string, DocumentFragment>();

function errorFragment(tex: string, message: string): DocumentFragment {
  const span = document.createElement('span');
  span.className = 'katex-error';
  span.title = message;
  span.textContent = tex;
  const fragment = document.createDocumentFragment();
  fragment.appendChild(span);
  return fragment;
}

/** The sanitized KaTeX rendering of `tex` (a fresh copy; renderings are cached). */
export function mathFragment(tex: string, displayMode: boolean): DocumentFragment {
  const key = (displayMode ? 'D' : 'I') + tex;
  let fragment = cache.get(key);
  if (fragment) {
    cache.delete(key);
  } else {
    try {
      fragment = sanitizeMath(katex.renderToString(tex, { ...OPTIONS, displayMode }));
    } catch (e) {
      // ParseErrors render inline (throwOnError: false); anything else lands here.
      fragment = errorFragment(tex, e instanceof Error ? e.message : String(e));
    }
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  }
  cache.set(key, fragment);
  return fragment.cloneNode(true) as DocumentFragment;
}

export function renderMathInto(target: HTMLElement, tex: string, displayMode: boolean): void {
  target.replaceChildren(mathFragment(tex, displayMode));
}
