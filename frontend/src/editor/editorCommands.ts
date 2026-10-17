// Editing commands bound in the editor keymap and exposed to the palette and mobile toolbar.
import { startCompletion } from '@codemirror/autocomplete';
import { EditorSelection, type ChangeSpec } from '@codemirror/state';
import type { Command } from '@codemirror/view';
import { noteContext } from './context';
import { linkAt } from './linkAt';

const TASK = /^(\s*(?:>\s?)*\s*(?:[-+*]|\d+[.)])\s+\[)([ xX])(\])/;
const LIST_ITEM = /^(\s*(?:>\s?)*\s*(?:[-+*]|\d+[.)])\s+)/;
const PREFIX = /^(\s*(?:>\s?)*\s*)/;

/** Mod-L: plain line → `- [ ] `, list item → task, task → toggled. */
export const toggleCheckbox: Command = (view) => {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();
  for (const range of state.selection.ranges) {
    for (let pos = range.from; pos <= range.to; ) {
      const line = state.doc.lineAt(pos);
      if (!seen.has(line.number)) {
        seen.add(line.number);
        const task = TASK.exec(line.text);
        if (task) {
          const at = line.from + task[1].length;
          changes.push({ from: at, to: at + 1, insert: task[2] === ' ' ? 'x' : ' ' });
        } else {
          const item = LIST_ITEM.exec(line.text);
          if (item) changes.push({ from: line.from + item[1].length, insert: '[ ] ' });
          else changes.push({ from: line.from + (PREFIX.exec(line.text)?.[1].length ?? 0), insert: '- [ ] ' });
        }
      }
      pos = line.to + 1;
    }
  }
  // A caret where a prefix goes in moves after it ("- [ ] |", "- [ ] |text"), so typing
  // continues inside the task.
  const changeSet = state.changes(changes);
  view.dispatch({ changes: changeSet, selection: state.selection.map(changeSet, 1), userEvent: 'input', scrollIntoView: true });
  return true;
};

function toggleWrap(marker: string): Command {
  return (view) => {
    const { state } = view;
    const len = marker.length;
    const tr = state.changeByRange((range) => {
      const before = state.sliceDoc(range.from - len, range.from);
      const after = state.sliceDoc(range.to, range.to + len);
      if (before === marker && after === marker) {
        return {
          changes: [
            { from: range.from - len, to: range.from },
            { from: range.to, to: range.to + len },
          ],
          range: EditorSelection.range(range.anchor - len, range.head - len),
        };
      }
      const text = state.sliceDoc(range.from, range.to);
      if (text.length >= 2 * len && text.startsWith(marker) && text.endsWith(marker)) {
        return {
          changes: { from: range.from, to: range.to, insert: text.slice(len, -len) },
          range: EditorSelection.range(range.from, range.to - 2 * len),
        };
      }
      return {
        changes: [
          { from: range.from, insert: marker },
          { from: range.to, insert: marker },
        ],
        range: EditorSelection.range(range.anchor + len, range.head + len),
      };
    });
    view.dispatch(state.update(tr, { userEvent: 'input', scrollIntoView: true }));
    return true;
  };
}

export const toggleBold: Command = toggleWrap('**');
export const toggleItalic: Command = toggleWrap('*');
export const toggleInlineCode: Command = toggleWrap('`');

/** Types `#` (with a separating space when needed, since a tag must follow whitespace) and opens tag completion. */
export const insertTagSign: Command = (view) => {
  const { from, to } = view.state.selection.main;
  const before = view.state.sliceDoc(from - 1, from);
  const insert = before === '' || /\s/.test(before) ? '#' : ' #';
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input.type', scrollIntoView: true });
  startCompletion(view);
  return true;
};

/**
 * Inserts a `---` rule on its own line. A blank line is kept before it, because `---` right under
 * a paragraph would turn that paragraph into a heading.
 */
export const insertHorizontalRule: Command = (view) => {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const previousBlank = line.number === 1 || state.doc.line(line.number - 1).text.trim() === '';
  const blank = line.text.trim() === '';
  const from = blank ? line.from : line.to;
  const insert = blank ? (previousBlank ? '' : '\n') + '---\n' : '\n\n---\n';
  view.dispatch({ changes: { from, to: line.to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input', scrollIntoView: true });
  return true;
};

/** Mod-K: wraps the selection as `[text]()` with the cursor in the destination. */
export const insertMarkdownLink: Command = (view) => {
  const { state } = view;
  const tr = state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const insert = `[${text}]()`;
    const cursor = text ? range.from + insert.length - 1 : range.from + 1;
    return { changes: { from: range.from, to: range.to, insert }, range: EditorSelection.cursor(cursor) };
  });
  view.dispatch(state.update(tr, { userEvent: 'input', scrollIntoView: true }));
  return true;
};

/** Mod-Enter: follows the link or tag under the cursor. */
export const followLinkAtCursor: Command = (view) => {
  const ctx = view.state.facet(noteContext);
  const hit = linkAt(view.state, view.state.selection.main.head);
  if (!ctx || !hit) return false;
  if (hit.kind === 'internal') ctx.openLink(hit.target, hit.subpath);
  else if (hit.kind === 'tag') ctx.openTag(hit.tag);
  else window.open(hit.url, '_blank', 'noopener,noreferrer');
  return true;
};

export const saveNow: Command = (view) => {
  view.state.facet(noteContext)?.save();
  return true;
};

export const toggleMode: Command = (view) => {
  view.state.facet(noteContext)?.toggleMode();
  return true;
};
