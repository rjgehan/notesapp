// Lezer markdown extension for math in source mode (ROADMAP item 3): `$inline$`, `$$display$$`
// inside a paragraph, and `$$` blocks. The delimiter rules match the reading view's
// (@mdit/plugin-tex): an opening `$` is not followed by a space, a closing `$` is not preceded by
// one and not followed by a digit or letter, so prices like "$5 and $10" stay text.
import { styleTags, Tag } from '@lezer/highlight';
import type { BlockContext, Element, InlineContext, Line, MarkdownConfig } from '@lezer/markdown';

/** Highlight tags for math, styled by editor/highlight.ts. */
export const mathTags = {
  math: Tag.define(),
  mark: Tag.define(),
};

const DOLLAR = 36;
const BACKSLASH = 92;

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;
const isWordChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;

function parseInlineMath(cx: InlineContext, next: number, pos: number): number {
  if (next !== DOLLAR) return -1;
  if (cx.char(pos + 1) === DOLLAR) {
    // `$$…$$` inside a paragraph: display math.
    const close = cx.slice(pos + 2, cx.end).indexOf('$$');
    if (close < 0 || cx.slice(pos + 2, pos + 2 + close).trim() === '') return -1;
    const end = pos + 2 + close + 2;
    return cx.addElement(cx.elt('InlineMath', pos, end, [cx.elt('InlineMathMark', pos, pos + 2), cx.elt('InlineMathMark', end - 2, end)]));
  }
  const before = cx.char(pos - 1);
  const after = cx.char(pos + 1);
  if (before === DOLLAR || (before >= 0 && isWordChar(before)) || after < 0 || isSpace(after)) return -1;
  for (let i = pos + 1; i < cx.end; i++) {
    const c = cx.char(i);
    if (c === BACKSLASH) {
      i++;
      continue;
    }
    if (c !== DOLLAR) continue;
    const prev = cx.char(i - 1);
    const following = cx.char(i + 1);
    if (following !== DOLLAR && (following < 0 || !isWordChar(following)) && !isSpace(prev)) {
      return cx.addElement(cx.elt('InlineMath', pos, i + 1, [cx.elt('InlineMathMark', pos, pos + 1), cx.elt('InlineMathMark', i, i + 1)]));
    }
    // A lone `$` between spaces does not close; anything else ends the attempt.
    if (isSpace(prev) && (following < 0 || isSpace(following))) continue;
    return -1;
  }
  return -1;
}

function isMathBlockStart(line: Line): boolean {
  if (line.next !== DOLLAR || line.text.charCodeAt(line.pos + 1) !== DOLLAR) return false;
  // `$$x$$ more text` is inline display math in a paragraph, not a block.
  const rest = line.text.slice(line.pos + 2);
  const close = rest.indexOf('$$');
  return close < 0 || rest.slice(close + 2).trim() === '';
}

function closesOn(text: string, from: number): number {
  const trimmed = text.trimEnd();
  return trimmed.length - from >= 2 && trimmed.endsWith('$$') ? trimmed.length : -1;
}

/**
 * Whether the current line still belongs to the block's containers (blockquote, list item), the
 * check @lezer/markdown's own FencedCode parser makes. `Line.depth` and `BlockContext.stack` are not
 * in the public typings, so this reads them defensively; without them a block simply runs on.
 */
function continuesContainers(cx: BlockContext, line: Line): boolean {
  const depth = (line as unknown as { depth?: number }).depth;
  const stack = (cx as unknown as { stack?: unknown[] }).stack;
  return depth === undefined || stack === undefined || depth >= stack.length;
}

function parseBlockMath(cx: BlockContext, line: Line): boolean {
  if (!isMathBlockStart(line)) return false;
  const from = cx.lineStart + line.pos;
  const marks: Element[] = [cx.elt('BlockMathMark', from, from + 2)];
  const sameLine = closesOn(line.text, line.pos + 2);
  if (sameLine >= 0) {
    // `$$ x $$` on one line.
    marks.push(cx.elt('BlockMathMark', cx.lineStart + sameLine - 2, cx.lineStart + sameLine));
    cx.nextLine();
    cx.addElement(cx.elt('BlockMath', from, cx.prevLineEnd(), marks));
    return true;
  }
  while (cx.nextLine() && continuesContainers(cx, line)) {
    for (const m of line.markers) marks.push(m);
    const end = closesOn(line.text, line.pos);
    if (end >= 0) {
      marks.push(cx.elt('BlockMathMark', cx.lineStart + end - 2, cx.lineStart + end));
      cx.nextLine();
      break;
    }
  }
  cx.addElement(cx.elt('BlockMath', from, cx.prevLineEnd(), marks));
  return true;
}

export const MathSyntax: MarkdownConfig = {
  defineNodes: [{ name: 'InlineMath' }, { name: 'InlineMathMark' }, { name: 'BlockMath', block: true }, { name: 'BlockMathMark' }],
  parseInline: [{ name: 'InlineMath', parse: parseInlineMath, before: 'Escape' }],
  parseBlock: [{ name: 'BlockMath', parse: parseBlockMath, before: 'FencedCode', endLeaf: (_cx, line) => isMathBlockStart(line) }],
  props: [
    styleTags({
      'InlineMath BlockMath': mathTags.math,
      'InlineMathMark BlockMathMark': mathTags.mark,
    }),
  ],
};
