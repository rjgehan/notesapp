import { ensureSyntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { markdownNoteLanguage } from './language';
import { smartPunctuationGuard } from './smartPunctuation';

/** Simulates iOS replacing the text before the cursor with a smart character. */
function typeSmart(doc: string, cursor: number, replaceFrom: number, insert: string): string {
  let state = EditorState.create({ doc, selection: EditorSelection.cursor(cursor), extensions: [markdownNoteLanguage(), smartPunctuationGuard] });
  ensureSyntaxTree(state, state.doc.length, 5000);
  state = state.update({ changes: { from: replaceFrom, to: cursor, insert }, userEvent: 'input.type' }).state;
  return state.doc.toString();
}

describe('smartPunctuationGuard', () => {
  it('reverts an em dash typed as -- at the start of a line', () => {
    expect(typeSmart('-', 1, 0, '—')).toBe('--');
  });

  it('reverts curly quotes inside frontmatter', () => {
    const doc = '---\ntags: \n---\nBody';
    const at = doc.indexOf('tags: ') + 6;
    expect(typeSmart(doc, at, at, '“')).toBe('---\ntags: "\n---\nBody');
  });

  it('reverts curly quotes inside inline code', () => {
    const doc = 'a `x` b';
    expect(typeSmart(doc, 4, 4, '’')).toBe("a `x'` b");
  });

  it('keeps smart punctuation in ordinary prose', () => {
    expect(typeSmart('He said ', 8, 8, '“')).toBe('He said “');
    expect(typeSmart('a -', 3, 2, '—')).toBe('a —');
  });
});
