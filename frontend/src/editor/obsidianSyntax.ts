// Lezer markdown extension for Obsidian syntax (DESIGN §6.6 #6): WikiLink, Embed, Hashtag,
// Highlight (==x==) and Comment (%%x%%, inline and block). The tag and wikilink rules use the
// shared patterns of features/syntax.ts (API.md §15.6).
import { styleTags, tags as t, Tag } from '@lezer/highlight';
import type { BlockContext, DelimiterType, InlineContext, Line, MarkdownConfig } from '@lezer/markdown';
import { isWhitespace, matchWikiLinkAt, splitWikiBody, tagBodyLength } from '../features/syntax';

/** Highlight tags for the Obsidian nodes, styled by editor/highlight.ts. */
export const obsidianTags = {
  wikiLink: Tag.define(t.link),
  wikiMark: Tag.define(t.processingInstruction),
  hashtag: Tag.define(t.labelName),
  highlight: Tag.define(),
  comment: Tag.define(t.comment),
};

const HighlightDelim: DelimiterType = { resolve: 'Highlight', mark: 'HighlightMark' };
const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~\p{P}\p{S}]/u;

function parseWikiLink(cx: InlineContext, next: number, pos: number): number {
  const embed = next === 33; /* ! */
  if (embed ? cx.char(pos + 1) !== 91 || cx.char(pos + 2) !== 91 : next !== 91 || cx.char(pos + 1) !== 91) return -1;
  const local = pos - cx.offset;
  const end = matchWikiLinkAt(cx.text, local);
  if (end < 0) return -1;
  const open = embed ? 3 : 2;
  const bodyFrom = pos + open;
  const bodyTo = cx.offset + end - 2;
  const split = splitWikiBody(cx.slice(bodyFrom, bodyTo));
  const children = [cx.elt('WikiLinkMark', pos, bodyFrom)];
  const targetEnd = split.sepFrom >= 0 ? bodyFrom + split.sepFrom : bodyTo;
  if (targetEnd > bodyFrom) children.push(cx.elt('WikiLinkTarget', bodyFrom, targetEnd));
  if (split.sepFrom >= 0) {
    children.push(cx.elt('WikiLinkMark', bodyFrom + split.sepFrom, bodyFrom + split.sepTo));
    if (bodyTo > bodyFrom + split.sepTo) children.push(cx.elt('WikiLinkAlias', bodyFrom + split.sepTo, bodyTo));
  }
  children.push(cx.elt('WikiLinkMark', bodyTo, bodyTo + 2));
  return cx.addElement(cx.elt(embed ? 'Embed' : 'WikiLink', pos, bodyTo + 2, children));
}

function parseHashtag(cx: InlineContext, next: number, pos: number): number {
  if (next !== 35 /* # */) return -1;
  if (pos > cx.offset && !isWhitespace(cx.slice(pos - 1, pos))) return -1;
  // Never a tag inside a markdown link's text (`[see #x](url)`).
  if (cx.hasOpenLink && /\]\(/.test(cx.slice(pos, cx.end))) return -1;
  const len = tagBodyLength(cx.slice(pos + 1, cx.end));
  if (len === 0) return -1;
  return cx.addElement(cx.elt('Hashtag', pos, pos + 1 + len, [cx.elt('HashtagMark', pos, pos + 1)]));
}

function parseHighlight(cx: InlineContext, next: number, pos: number): number {
  if (next !== 61 /* = */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61) return -1;
  const before = cx.slice(pos - 1, pos);
  const after = cx.slice(pos + 2, pos + 3);
  const sBefore = /\s|^$/.test(before);
  const sAfter = /\s|^$/.test(after);
  const pBefore = PUNCTUATION.test(before);
  const pAfter = PUNCTUATION.test(after);
  return cx.addDelimiter(
    HighlightDelim,
    pos,
    pos + 2,
    !sAfter && (!pAfter || sBefore || pBefore),
    !sBefore && (!pBefore || sAfter || pAfter),
  );
}

function parseInlineComment(cx: InlineContext, next: number, pos: number): number {
  if (next !== 37 /* % */ || cx.char(pos + 1) !== 37) return -1;
  const close = cx.slice(pos + 2, cx.end).indexOf('%%');
  if (close < 0) return -1;
  const end = pos + 2 + close + 2;
  return cx.addElement(cx.elt('Comment', pos, end, [cx.elt('CommentMark', pos, pos + 2), cx.elt('CommentMark', end - 2, end)]));
}

/** A `%%` at the start of a line whose comment does not close on that line: runs to the closing `%%` (or EOF). */
function parseCommentBlock(cx: BlockContext, line: Line): boolean {
  const text = line.text;
  if (!text.startsWith('%%', line.pos)) return false;
  const rest = text.slice(line.pos + 2);
  const sameLineClose = rest.indexOf('%%');
  if (sameLineClose >= 0 && rest.slice(sameLineClose + 2).trim() !== '') return false;
  const start = cx.lineStart + line.pos;
  if (sameLineClose >= 0) {
    const end = cx.lineStart + text.length;
    cx.nextLine();
    cx.addElement(cx.elt('CommentBlock', start, end, [cx.elt('CommentMark', start, start + 2), cx.elt('CommentMark', end - 2, end)]));
    return true;
  }
  let end = cx.lineStart + text.length;
  let closeMark: [number, number] | null = null;
  while (cx.nextLine()) {
    const idx = line.text.indexOf('%%');
    end = cx.lineStart + line.text.length;
    if (idx >= 0) {
      closeMark = [cx.lineStart + idx, cx.lineStart + idx + 2];
      cx.nextLine();
      break;
    }
  }
  const children = [cx.elt('CommentMark', start, start + 2)];
  if (closeMark) children.push(cx.elt('CommentMark', closeMark[0], closeMark[1]));
  cx.addElement(cx.elt('CommentBlock', start, end, children));
  return true;
}

export const ObsidianSyntax: MarkdownConfig = {
  defineNodes: [
    { name: 'WikiLink' },
    { name: 'Embed' },
    { name: 'WikiLinkMark' },
    { name: 'WikiLinkTarget' },
    { name: 'WikiLinkAlias' },
    { name: 'Hashtag' },
    { name: 'HashtagMark' },
    { name: 'Highlight' },
    { name: 'HighlightMark' },
    { name: 'Comment' },
    { name: 'CommentBlock', block: true },
    { name: 'CommentMark' },
  ],
  parseInline: [
    { name: 'Comment', parse: parseInlineComment, before: 'Emphasis' },
    { name: 'WikiLink', parse: parseWikiLink, before: 'Link' },
    { name: 'Hashtag', parse: parseHashtag, before: 'Emphasis' },
    { name: 'Highlight', parse: parseHighlight, after: 'Emphasis' },
  ],
  parseBlock: [{ name: 'CommentBlock', parse: parseCommentBlock, before: 'FencedCode' }],
  props: [
    styleTags({
      'WikiLink/WikiLinkTarget Embed/WikiLinkTarget': obsidianTags.wikiLink,
      'WikiLinkAlias': obsidianTags.wikiLink,
      'WikiLinkMark HighlightMark': obsidianTags.wikiMark,
      'Hashtag/...': obsidianTags.hashtag,
      'Link/Hashtag Image/Hashtag': t.link,
      Highlight: obsidianTags.highlight,
      'Comment CommentBlock CommentMark': obsidianTags.comment,
    }),
  ],
};
