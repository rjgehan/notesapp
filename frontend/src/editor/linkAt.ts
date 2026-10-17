// Finds the link or tag at a document position, from the syntax tree.
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { isInternalDestination, parseMarkdownDestination, splitWikiBody } from '../features/syntax';

export type LinkHit =
  | { kind: 'internal'; target: string; subpath: string | null; from: number; to: number }
  | { kind: 'external'; url: string; from: number; to: number }
  | { kind: 'tag'; tag: string; from: number; to: number };

/** Names of nodes where links and tags are never recognized. */
export const CODE_NODES = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText', 'Comment', 'CommentBlock', 'HTMLBlock']);

export function inCodeOrComment(state: EditorState, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (CODE_NODES.has(node.name)) return true;
  }
  return false;
}

const PURE_CODE_NODES = new Set(['InlineCode', 'FencedCode', 'CodeBlock', 'CodeText']);

export function inCode(state: EditorState, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (PURE_CODE_NODES.has(node.name)) return true;
  }
  return false;
}

export function inFrontmatter(state: EditorState, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (node.name === 'FrontmatterContent' || node.name === 'DashLine') return true;
    if (node.name === 'Body') return false;
  }
  return false;
}

function fromNode(state: EditorState, node: SyntaxNode): LinkHit | null {
  if (node.name === 'WikiLink' || node.name === 'Embed') {
    const open = node.name === 'Embed' ? 3 : 2;
    const body = state.sliceDoc(node.from + open, node.to - 2);
    const split = splitWikiBody(body);
    return { kind: 'internal', target: split.target, subpath: split.subpath, from: node.from, to: node.to };
  }
  if (node.name === 'Hashtag') {
    return { kind: 'tag', tag: state.sliceDoc(node.from + 1, node.to), from: node.from, to: node.to };
  }
  if (node.name === 'Link' || node.name === 'Image') {
    const url = node.getChild('URL');
    if (!url) return null;
    const dest = state.sliceDoc(url.from, url.to);
    if (!isInternalDestination(dest) && !dest.startsWith('<')) return { kind: 'external', url: dest, from: node.from, to: node.to };
    const { target, subpath } = parseMarkdownDestination(dest);
    return { kind: 'internal', target, subpath, from: node.from, to: node.to };
  }
  if (node.name === 'URL' && node.parent?.name === 'Autolink') {
    return { kind: 'external', url: state.sliceDoc(node.from, node.to), from: node.from, to: node.to };
  }
  return null;
}

/** The innermost link, embed or tag covering `pos` (either side). */
export function linkAt(state: EditorState, pos: number): LinkHit | null {
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); node; node = node.parent) {
      const hit = fromNode(state, node);
      if (hit) return hit;
    }
  }
  // Bare URLs (GFM autolink extension produce URL nodes without Autolink parents).
  const line = state.doc.lineAt(pos);
  for (const m of line.text.matchAll(/https?:\/\/[^\s<>()]+/g)) {
    const from = line.from + m.index;
    if (pos >= from && pos <= from + m[0].length) return { kind: 'external', url: m[0], from, to: from + m[0].length };
  }
  return null;
}
