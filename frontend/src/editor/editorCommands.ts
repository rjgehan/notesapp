// Editing commands bound in the editor keymap and exposed to the palette and mobile toolbar. The
// formatting toggles (bold, italic, links, headings, lists) are in formatting.ts.
import { startCompletion } from '@codemirror/autocomplete';
import type { ChangeSpec } from '@codemirror/state';
import type { Command, EditorView } from '@codemirror/view';
import { noteContext } from './context';
import { linkAt, type LinkHit } from './linkAt';

const TASK = /^(\s*(?:>\s?)*\s*(?:[-+*]|\d+[.)])\s+\[)([ xX])(\])/;
const LIST_ITEM = /^(\s*(?:>\s?)*\s*(?:[-+*]|\d+[.)])\s+)/;
const PREFIX = /^(\s*(?:>\s?)*\s*)/;

/** Mod-L: plain line → `- [ ] `, list item → task, task → toggled. */
export const toggleCheckbox: Command = (view) => {
  const { state } = view;
  if (state.readOnly) return false;
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

/** Types `#` (with a separating space when needed, since a tag must follow whitespace) and opens tag completion. */
export const insertTagSign: Command = (view) => {
  if (view.state.readOnly) return false;
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
  if (state.readOnly) return false;
  const line = state.doc.lineAt(state.selection.main.head);
  const previousBlank = line.number === 1 || state.doc.line(line.number - 1).text.trim() === '';
  const blank = line.text.trim() === '';
  const from = blank ? line.from : line.to;
  const insert = blank ? (previousBlank ? '' : '\n') + '---\n' : '\n\n---\n';
  view.dispatch({ changes: { from, to: line.to, insert }, selection: { anchor: from + insert.length }, userEvent: 'input', scrollIntoView: true });
  return true;
};

/** Web addresses a link may open: the schemes the reading view's sanitizer keeps, and `//host` links. */
const OPENABLE_URL = /^(?:(?:https?|ftps?|mailto|tel|callto|sms|xmpp|matrix):|\/\/)/i;

/** Opens a web link from a note in a new tab, without access to this page; other schemes (`javascript:`) never open. */
export function openExternalUrl(url: string): boolean {
  if (!OPENABLE_URL.test(url.trim())) return false;
  window.open(url.trim(), '_blank', 'noopener,noreferrer');
  return true;
}

/** Follows a link or tag found in the editor: notes in the app, tags in search, web links in a new tab. */
export function followLink(view: EditorView, hit: LinkHit): boolean {
  const ctx = view.state.facet(noteContext);
  if (!ctx) return false;
  if (hit.kind === 'internal') ctx.openLink(hit.target, hit.subpath);
  else if (hit.kind === 'tag') ctx.openTag(hit.tag);
  else openExternalUrl(hit.url);
  return true;
}

/** Mod-Enter: follows the link or tag under the cursor. */
export const followLinkAtCursor: Command = (view) => {
  const hit = linkAt(view.state, view.state.selection.main.head);
  return hit !== null && followLink(view, hit);
};

export const saveNow: Command = (view) => {
  view.state.facet(noteContext)?.save();
  return true;
};
