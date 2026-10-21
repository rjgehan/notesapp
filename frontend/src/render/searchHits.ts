// Search-hit navigation in the reading view (DESIGN §6.4 `?line=N&q=`): the target block flashes,
// and the query's terms are highlighted with the CSS Custom Highlight API, which never touches the
// rendered DOM (so block patching and embeds are unaffected). Browsers without it only flash.
import { findTermRanges, type HighlightTerm } from '../features/searchTerms';

const HIGHLIGHT_NAME = 'search-term';
const MAX_RANGES = 500;

function highlightRegistry(): HighlightRegistry | null {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight === 'function' ? CSS.highlights : null;
}

/** Highlights `terms` in the container's text; returns the cleanup. */
export function highlightTermsIn(container: HTMLElement, terms: readonly HighlightTerm[]): () => void {
  const registry = highlightRegistry();
  if (!registry || terms.length === 0) return () => {};
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && ranges.length < MAX_RANGES; node = walker.nextNode()) {
    if (node.parentElement?.closest('[data-embed-root], script, style')) continue;
    for (const r of findTermRanges(node.textContent ?? '', terms)) {
      const range = document.createRange();
      range.setStart(node, r.from);
      range.setEnd(node, r.to);
      ranges.push(range);
    }
  }
  registry.set(HIGHLIGHT_NAME, new Highlight(...ranges));
  return () => registry.delete(HIGHLIGHT_NAME);
}

/** Briefly flashes a block (the line of a search hit). */
export function flashBlock(el: HTMLElement): void {
  el.classList.remove('is-flash');
  // Restart the animation when the same block flashes twice.
  void el.offsetWidth;
  el.classList.add('is-flash');
  setTimeout(() => el.classList.remove('is-flash'), 1800);
}
