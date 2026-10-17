// Marks wikilinks and internal Markdown links that the client resolver cannot resolve with
// `cm-unresolved` (DESIGN §6.6 #9), as Obsidian fades them.
import { syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { resolve } from '../features/links';
import { isInternalDestination, parseMarkdownDestination, splitWikiBody } from '../features/syntax';
import { noteContext, vaultChanged } from './context';

const unresolvedMark = Decoration.mark({ class: 'cm-unresolved' });

function build(view: EditorView): DecorationSet {
  const ctx = view.state.facet(noteContext);
  const builder = new RangeSetBuilder<Decoration>();
  if (!ctx) return builder.finish();
  const index = ctx.tree().links;
  const source = ctx.path();
  const { state } = view;
  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        let target: string;
        if (node.name === 'WikiLink' || node.name === 'Embed') {
          const open = node.name === 'Embed' ? 3 : 2;
          target = splitWikiBody(state.sliceDoc(node.from + open, node.to - 2)).target;
        } else if (node.name === 'Link' || node.name === 'Image') {
          const url = node.node.getChild('URL');
          if (!url) return false;
          const dest = state.sliceDoc(url.from, url.to);
          if (!isInternalDestination(dest) && !dest.startsWith('<')) return false;
          target = parseMarkdownDestination(dest).target;
        } else {
          return undefined;
        }
        if (target !== '' && resolve(target, source, index) === null) builder.add(node.from, node.to, unresolvedMark);
        return false;
      },
    });
  }
  return builder.finish();
}

export const unresolvedLinks: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(update: ViewUpdate) {
      const vaultChange = update.transactions.some((tr) => tr.effects.some((e) => e.is(vaultChanged)));
      if (update.docChanged || update.viewportChanged || vaultChange || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
