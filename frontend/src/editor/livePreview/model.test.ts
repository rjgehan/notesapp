import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { markdownNoteLanguage } from '../language';
import { buildLivePreview } from './decorations';
import { collectElements, hiddenPieces, HIDE_ALL, isRevealed, type RevealOptions, type WidgetSpec } from './model';

function state(doc: string, cursor = 0): EditorState {
  const s = EditorState.create({ doc, selection: EditorSelection.cursor(cursor), extensions: [markdownNoteLanguage()] });
  ensureSyntaxTree(s, s.doc.length, 5000);
  return s;
}

function token(widget: WidgetSpec | null): string {
  if (!widget) return '';
  switch (widget.type) {
    case 'bullet':
      return '•';
    case 'checkbox':
      return widget.checked ? '☑' : '☐';
    case 'rule':
      return '———';
    case 'text':
      return widget.text;
  }
}

/** The note as Live Preview shows it: hidden markup removed, widgets as tokens. */
function shown(s: EditorState, options: RevealOptions = HIDE_ALL, selection: EditorSelection = s.selection): string {
  const pieces = hiddenPieces(collectElements(s, [{ from: 0, to: s.doc.length }]), selection, options).sort((a, b) => a.from - b.from);
  let out = '';
  let pos = 0;
  for (const p of pieces) {
    expect(p.from).toBeGreaterThanOrEqual(pos);
    out += s.sliceDoc(pos, p.from) + token(p.widget);
    pos = p.to;
  }
  return out + s.sliceDoc(pos);
}

const REVEAL: RevealOptions = { atCursor: true, atSelectionEnds: true, completing: false };

describe('Live Preview rendering, hide-all (ROADMAP 10a)', () => {
  const corpus: Array<[string, string, string]> = [
    ['headings', '# Title\n\n## Sub ##\n\n###### Six', 'Title\n\nSub\n\nSix'],
    ['a heading being typed, and a line-start tag', '#\n\n#tag here', '#\n\n#tag here'],
    ['an empty heading keeps its size', '# ', ''],
    ['inline formatting', '**bold**, *it*, _it_, ~~gone~~, ==mark== and `code`', 'bold, it, it, gone, mark and code'],
    ['nested formatting', '***both*** and **bold *it***', 'both and bold it'],
    ['wikilinks', '[[Note]] [[Note|alias]] [[Note#Head]] [[#Local]] [[Note#A#B]] [[Note|]]', 'Note alias Note > Head Local Note > A > B Note'],
    ['web links', '[text](https://x.y "title") <https://a.b> https://bare.example', 'text https://a.b https://bare.example'],
    ['formatting inside a link', '[**bold** link](https://x.y)', 'bold link'],
    ['bullets and tasks', '- one\n  - two\n- [ ] task\n- [x] done\n* star\n+ plus', '•one\n•two\n☐task\n☑done\n•star\n•plus'],
    ['numbered lists keep their numbers', '1. first\n2. [ ] numbered task\n3) third', '1. first\n2. ☐numbered task\n3) third'],
    ['list markers being typed', '-\n\n- ', '-\n\n•'],
    ['quotes', '> quote\n> > nested\n> - [ ] in a quote', 'quote\nnested\n☐in a quote'],
    ['rules', 'Text\n\n---\n\n***', 'Text\n\n———\n\n———'],
    ['setext headings keep their underline', 'Title\n===', 'Title\n==='],
    ['code blocks show as typed', '```\n**not bold** [[x]]\n```\n\n    indented **code**', '```\n**not bold** [[x]]\n```\n\n    indented **code**'],
    ['inline code hides only its backticks', '`**x**` and ``a ` b``', '**x** and a ` b'],
    ['comments, embeds, images and tables stay for 10b', '%%c **b**%%\n\n![[Pic.png]] ![alt](a.png)\n\n| a | **b** |\n|---|---|\n| 1 | 2 |', '%%c **b**%%\n\n![[Pic.png]] ![alt](a.png)\n\n| a | **b** |\n|---|---|\n| 1 | 2 |'],
    ['frontmatter shows as typed', '---\ntitle: "**x**"\n---\n# H', '---\ntitle: "**x**"\n---\nH'],
    ['escapes, reference links and links without text', '\\*not\\* [a][b] [](u) [e]()', '\\*not\\* [a][b] [](u) [e]()'],
    ['hashtags', 'a #tag and #nested/tag', 'a #tag and #nested/tag'],
  ];

  for (const [name, doc, expected] of corpus) {
    it(name, () => {
      expect(shown(state(doc))).toBe(expected);
    });
  }

  it('never changes the document', () => {
    const doc = corpus.map((c) => c[1]).join('\n\n');
    const s = state(doc);
    buildLivePreview(s, [{ from: 0, to: s.doc.length }], { visibility: 'hide-all', locked: false, checkboxes: true, selection: s.selection, focused: true, completing: false });
    expect(s.doc.toString()).toBe(doc);
  });

  it('keeps markup hidden under the cursor', () => {
    const s = state('a **bold** b\n# Head', 5);
    expect(shown(s, { ...HIDE_ALL, atSelectionEnds: true })).toBe('a bold b\nHead');
  });

  it('shows markup a selection end is inside of (a search match, a command’s caret)', () => {
    const s = state('[t](https://x.y) and **b**');
    const inUrl = EditorSelection.create([EditorSelection.range(4, 9)]);
    expect(shown(s, { ...HIDE_ALL, atSelectionEnds: true }, inUrl)).toBe('[t](https://x.y) and b');
  });

  it('shows the link being completed', () => {
    const s = state('see [[Pla]]', 9);
    const el = collectElements(s, [{ from: 0, to: s.doc.length }]).find((e) => e.kind === 'wikilink')!;
    expect(isRevealed(el, s.selection, { ...HIDE_ALL, completing: true })).toBe(true);
    expect(isRevealed(el, s.selection, HIDE_ALL)).toBe(false);
  });

  it('only computes the requested ranges', () => {
    const s = state('**a**\n\n**b**\n\n**c**');
    const kinds = collectElements(s, [{ from: 7, to: 12 }]).map((e) => s.sliceDoc(e.from, e.to));
    expect(kinds).toEqual(['**b**']);
  });
});

describe('Live Preview rendering, reveal-at-cursor', () => {
  const at = (doc: string, cursor: number) => {
    const s = state(doc, cursor);
    return shown(s, REVEAL);
  };

  it('shows the markers of the element at the cursor, and only those', () => {
    expect(at('a **bold** and *it*', 5)).toBe('a **bold** and it');
    expect(at('a **bold** and *it*', 0)).toBe('a bold and it');
  });

  it('counts a cursor touching an element as in it', () => {
    expect(at('a **bold** b', 10)).toBe('a **bold** b');
    expect(at('a **bold** b', 11)).toBe('a bold b');
  });

  it('shows nested markup around the cursor', () => {
    expect(at('[**b** x](https://u)', 3)).toBe('[**b** x](https://u)');
  });

  it('shows a heading’s marks on its line, a quote’s on its line, a bullet’s next to it', () => {
    expect(at('# Title\nnext', 4)).toBe('# Title\nnext');
    expect(at('# Title\nnext', 9)).toBe('Title\nnext');
    expect(at('> a\n> b', 5)).toBe('a\n> b');
    expect(at('- one\n- two', 3)).toBe('•one\n•two');
    expect(at('- one\n- two', 2)).toBe('- one\n•two');
  });
});
