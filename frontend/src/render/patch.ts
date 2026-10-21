// Per-block keyed DOM patching (DESIGN §6.7 #8). Re-rendering never replaces the whole container:
// unchanged top-level blocks keep their DOM nodes (embedded images, iframes, media, transclusions)
// and only get their `data-line` values updated.

/**
 * The block's key: its rendered HTML without `data-line` attributes and task-checkbox state
 * (`checked`, `data-hash`), which are synced onto a kept block instead. Stored at insertion time,
 * so later changes to the live DOM (hydrated math and diagrams, an opened callout) never change it.
 */
const keys = new WeakMap<Node, string>();

const TAG = /<[^>]*>/g;
// Only stripped inside tags: in a tag, a value's quotes are escaped, so this never matches text.
const VOLATILE = / (?:data-line|data-hash|checked)="[^"]*"/g;

function keyOf(node: Node): string {
  if (node instanceof Element) return node.outerHTML.replace(TAG, (tag) => tag.replace(VOLATILE, ''));
  return `#${node.nodeType}:${node.textContent ?? ''}`;
}

/** Copies `data-line` values and checkbox states from a freshly rendered block onto the kept one. */
function syncLines(kept: Element, fresh: Element): void {
  const keptLines = [kept, ...kept.querySelectorAll('[data-line]')].filter((el) => el.hasAttribute('data-line') && !el.closest('[data-embed-root]'));
  const freshLines = [fresh, ...fresh.querySelectorAll('[data-line]')].filter((el) => el.hasAttribute('data-line'));
  if (keptLines.length !== freshLines.length) return;
  keptLines.forEach((el, i) => {
    const value = freshLines[i].getAttribute('data-line');
    if (value !== null && el.getAttribute('data-line') !== value) el.setAttribute('data-line', value);
  });
  // A checkbox toggled in this view (or on another device) keeps its block, so an opened callout
  // or a playing video around the task is not replaced.
  const keptBoxes = [...kept.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox')].filter((el) => !el.closest('[data-embed-root]'));
  const freshBoxes = [...fresh.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox')];
  if (keptBoxes.length !== freshBoxes.length) return;
  keptBoxes.forEach((box, i) => {
    const checked = freshBoxes[i].hasAttribute('checked');
    box.checked = checked;
    box.toggleAttribute('checked', checked);
    const hash = freshBoxes[i].getAttribute('data-hash');
    if (hash !== null) box.setAttribute('data-hash', hash);
  });
}

export interface PatchStats {
  kept: number;
  inserted: number;
  removed: number;
}

/**
 * Makes `container`'s children match the fragment's, reusing old nodes whose key matches.
 * `onRemove` runs for every discarded node (to unmount hydrated embeds).
 */
export function patchChildren(container: Element, fragment: DocumentFragment, onRemove?: (node: Node) => void): PatchStats {
  const fresh = [...fragment.childNodes].filter((n) => !(n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() === ''));
  const pool = new Map<string, Node[]>();
  for (const old of [...container.childNodes]) {
    const key = keys.get(old) ?? keyOf(old);
    const list = pool.get(key);
    if (list) list.push(old);
    else pool.set(key, [old]);
  }

  const stats: PatchStats = { kept: 0, inserted: 0, removed: 0 };
  const result: Node[] = [];
  for (const node of fresh) {
    const key = keyOf(node);
    const reuse = pool.get(key)?.shift();
    if (reuse) {
      if (reuse instanceof Element && node instanceof Element) syncLines(reuse, node);
      result.push(reuse);
      stats.kept++;
    } else {
      keys.set(node, key);
      result.push(node);
      stats.inserted++;
    }
  }

  for (const leftovers of pool.values()) {
    for (const old of leftovers) {
      onRemove?.(old);
      old.parentNode?.removeChild(old);
      stats.removed++;
    }
  }

  let cursor: ChildNode | null = container.firstChild;
  for (const node of result) {
    if (node === cursor) {
      cursor = cursor.nextSibling;
    } else {
      container.insertBefore(node, cursor);
    }
  }
  return stats;
}
