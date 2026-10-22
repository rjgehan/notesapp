// Scroll mapping between the editor and the reading view through `data-line` (DESIGN §6.7 #8).

/** Scrolls the block covering 0-based `line` into view. */
export function scrollToLine(container: HTMLElement, line: number): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestLine = -1;
  for (const el of container.querySelectorAll<HTMLElement>('[data-line]')) {
    if (el.closest('[data-embed-root]')) continue;
    const l = Number(el.dataset.line);
    if (l <= line && l >= bestLine) {
      best = el;
      bestLine = l;
    }
  }
  best?.scrollIntoView({ block: 'start' });
  return best;
}

/** The source line of the first block visible at the top of `scroller`. */
export function topVisibleLine(container: HTMLElement, scroller: HTMLElement): number | null {
  const top = scroller.getBoundingClientRect().top;
  for (const el of container.querySelectorAll<HTMLElement>('[data-line]')) {
    if (el.closest('[data-embed-root]')) continue;
    if (el.getBoundingClientRect().bottom > top + 4) return Number(el.dataset.line);
  }
  return null;
}

/** The rendered block with Obsidian block id `id` (case-insensitive), outside embeds, or null. */
export function findBlockElement(container: HTMLElement, id: string): HTMLElement | null {
  const key = id.toLowerCase();
  for (const el of container.querySelectorAll<HTMLElement>('[data-block-id]')) {
    if (el.closest('[data-embed-root]')) continue;
    if ((el.dataset.blockId ?? '').toLowerCase() === key) return el;
  }
  return null;
}
