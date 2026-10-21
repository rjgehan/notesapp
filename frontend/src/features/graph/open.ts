// Opening a graph node (ROADMAP item 16): a file opens, an unresolved link creates its note the way
// following the link would, and a tag opens the search for it.
import { openLink, openPath, openTag } from '../navigation';
import type { BaseGraph, GraphNodeModel } from './model';

/** A note that links to the base node `index` (the first edge into it), or null. */
export function firstSource(base: BaseGraph, index: number): string | null {
  const e = base.edges;
  for (let k = 0; k < e.length; k += 3) {
    if (e[k + 1] === index) return base.nodes[e[k]!]!.path;
  }
  return null;
}

export function openGraphNode(base: BaseGraph | null, node: GraphNodeModel): void {
  switch (node.type) {
    case 'tag':
      openTag(node.label.replace(/^#/, ''));
      return;
    case 'unresolved': {
      const index = base?.byId.get(node.id);
      const source = base && index !== undefined ? firstSource(base, index) : null;
      void openLink(node.path, null, source ?? '');
      return;
    }
    default:
      openPath(node.path);
  }
}
