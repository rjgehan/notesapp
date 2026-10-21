// Styled source mode (DESIGN §6.6 #7): token colours plus per-line classes for headings, code
// blocks, quotes, comments and frontmatter. Nothing is hidden; marks are only faded.
import { HighlightStyle, syntaxTree } from '@codemirror/language';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { obsidianTags } from './obsidianSyntax';

export const obsidianHighlight = HighlightStyle.define([
  { tag: t.heading1, class: 'cm-h cm-h1' },
  { tag: t.heading2, class: 'cm-h cm-h2' },
  { tag: t.heading3, class: 'cm-h cm-h3' },
  { tag: t.heading4, class: 'cm-h cm-h4' },
  { tag: t.heading5, class: 'cm-h cm-h5' },
  { tag: t.heading6, class: 'cm-h cm-h6' },
  { tag: t.strong, class: 'cm-strong' },
  { tag: t.emphasis, class: 'cm-em' },
  { tag: t.strikethrough, class: 'cm-strike' },
  { tag: t.processingInstruction, class: 'cm-formatting' },
  { tag: obsidianTags.wikiMark, class: 'cm-formatting' },
  { tag: t.monospace, class: 'cm-inline-code' },
  { tag: t.link, class: 'cm-link' },
  { tag: t.url, class: 'cm-url' },
  { tag: obsidianTags.wikiLink, class: 'cm-link cm-wikilink' },
  { tag: obsidianTags.hashtag, class: 'cm-hashtag' },
  { tag: obsidianTags.highlight, class: 'cm-highlight' },
  { tag: obsidianTags.comment, class: 'cm-comment' },
  { tag: t.quote, class: 'cm-quote' },
  { tag: t.contentSeparator, class: 'cm-hr' },
  { tag: t.meta, class: 'cm-meta' },
  // YAML (frontmatter) and fenced code tokens.
  { tag: [t.propertyName, t.definition(t.propertyName)], class: 'cm-tok-property' },
  { tag: [t.keyword, t.operatorKeyword, t.modifier], class: 'cm-tok-keyword' },
  { tag: [t.string, t.special(t.string), t.regexp], class: 'cm-tok-string' },
  { tag: [t.number, t.bool, t.null, t.atom], class: 'cm-tok-number' },
  { tag: [t.lineComment, t.blockComment], class: 'cm-tok-comment' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: 'cm-tok-function' },
  { tag: [t.typeName, t.className, t.namespace], class: 'cm-tok-type' },
  { tag: [t.variableName, t.labelName], class: 'cm-tok-variable' },
  { tag: [t.tagName, t.angleBracket], class: 'cm-tok-tag' },
  { tag: t.attributeName, class: 'cm-tok-attribute' },
  { tag: t.invalid, class: 'cm-tok-invalid' },
]);

const HEADING = /^(?:ATXHeading|SetextHeading)([1-6])$/;

function lineClasses(view: EditorView): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const classes = new Map<number, string[]>();
  // The visible range being decorated: a block's lines outside it get no class (ROADMAP 10c: a
  // 5,000-line code block costs its visible lines, not all of them, on every update).
  let lo = 0;
  let hi = doc.length;
  const add = (blockFrom: number, blockTo: number, cls: string) => {
    const from = Math.max(blockFrom, lo);
    const to = Math.min(blockTo, hi);
    if (from > to) return;
    const last = doc.lineAt(Math.max(from, to - 1)).number;
    for (let n = doc.lineAt(from).number; n <= last; n++) {
      const list = classes.get(n);
      if (list) list.push(cls);
      else classes.set(n, [cls]);
    }
  };
  const tree = syntaxTree(state);
  for (const { from, to } of view.visibleRanges) {
    lo = from;
    hi = to;
    tree.iterate({
      from,
      to,
      enter(node) {
        const name = node.name;
        const heading = HEADING.exec(name);
        if (heading) {
          add(node.from, node.to, `cm-heading-line cm-heading-line-${heading[1]}`);
          return false;
        }
        if (name === 'FencedCode' || name === 'CodeBlock') {
          add(node.from, node.to, 'cm-codeblock-line');
          add(node.from, node.from, 'cm-codeblock-begin');
          add(node.to, node.to, 'cm-codeblock-end');
          return false;
        }
        if (name === 'Blockquote') add(node.from, node.to, 'cm-quote-line');
        if (name === 'CommentBlock') {
          add(node.from, node.to, 'cm-comment-line');
          return false;
        }
        if (name === 'HorizontalRule') add(node.from, node.to, 'cm-hr-line');
        if (name === 'Frontmatter') {
          add(node.from, node.to, 'cm-frontmatter-line');
        }
        return undefined;
      },
    });
  }
  const builder = new RangeSetBuilder<Decoration>();
  for (const n of [...classes.keys()].sort((a, b) => a - b)) {
    const line = doc.line(n);
    builder.add(line.from, line.from, Decoration.line({ class: [...new Set(classes.get(n))].join(' ') }));
  }
  return builder.finish();
}

export const lineClassPlugin: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = lineClasses(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
        this.decorations = lineClasses(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
