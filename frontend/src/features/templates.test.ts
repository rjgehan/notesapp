import { undo } from '@codemirror/commands';
import { EditorSelection, Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { MockVault } from '../api/mock/vault';
import { DocumentSession } from '../sync/DocumentSession';
import { fakeApi, sessionDeps } from '../test/fakes';
import { dayjs } from './dates';
import { mergeFrontmatter, renderTemplate, templateInsertion } from './templates';

const now = dayjs('2026-10-16T14:03:09');
const ctx = { title: 'Plan', now, settings: { dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm' } };

describe('renderTemplate (API.md §15.4 vectors)', () => {
  it.each([
    ['# {{title}}', '# Plan'],
    ['{{date}}', '2026-10-16'],
    ['{{ time }}', '14:03'],
    ['{{date:dddd, MMMM Do YYYY}}', 'Friday, October 16th 2026'],
    ['{{date:YYYY-[W]WW}}', '2026-W42'],
    ['{{DATE:YYYY}}', '2026'],
    ['{{weather}}', '{{weather}}'],
  ])('%s → %s', (input, output) => {
    expect(renderTemplate(input, ctx)).toBe(output);
  });

  it('renders {{time:FMT}} and every placeholder of a template', () => {
    expect(renderTemplate('{{time:h:mm A}} {{Title}} {{ date }} {{other}}', ctx)).toBe('2:03 PM Plan 2026-10-16 {{other}}');
  });

  it('uses the configured date and time formats', () => {
    expect(renderTemplate('{{date}} {{time}}', { ...ctx, settings: { dateFormat: 'DD.MM.YYYY', timeFormat: 'HH:mm:ss' } })).toBe('16.10.2026 14:03:09');
  });
});

describe('mergeFrontmatter', () => {
  it('follows the API.md §15.4 example', () => {
    const note = 'tags: [daily]\nmood: ok\n';
    const template = 'tags: [journal, Daily]\nmood: great\ncreated: "2026-10-16"\n';
    expect(mergeFrontmatter(note, template)).toBe('tags: [daily, journal]\nmood: ok\ncreated: "2026-10-16"\n');
  });

  it('appends missing keys and keeps comments', () => {
    const merged = mergeFrontmatter('# my note\ntitle: x # inline\n', 'status: draft\n');
    expect(merged).toBe('# my note\ntitle: x # inline\nstatus: draft\n');
  });

  it('unions lists case-insensitively only for tags, aliases and cssclasses', () => {
    expect(mergeFrontmatter('aliases:\n  - Road\n', 'aliases:\n  - road\n  - Plan\n')).toBe('aliases:\n  - Road\n  - Plan\n');
    expect(mergeFrontmatter('people: [Ann]\n', 'people: [ann, Bob]\n')).toBe('people: [Ann, ann, Bob]\n');
  });

  it("keeps the note's scalar, also against a template list", () => {
    expect(mergeFrontmatter('mood: ok\nkind: note\n', 'mood: great\nkind: [a, b]\n')).toBe('mood: ok\nkind: note\n');
  });

  it('returns the note unchanged when nothing is added, and null for invalid YAML', () => {
    expect(mergeFrontmatter('tags: [a]\n', 'tags: [A]\n')).toBe('tags: [a]\n');
    expect(mergeFrontmatter('a: [unclosed\n', 'b: 1\n')).toBeNull();
    expect(mergeFrontmatter('- a list\n', 'b: 1\n')).toBeNull();
  });
});

function apply(note: string, changes: { apply(t: Text): Text }): string {
  return changes.apply(Text.of(note.split('\n'))).toString();
}

describe('templateInsertion', () => {
  const template = '---\ntags: [journal, Daily]\nmood: great\ncreated: "{{date}}"\n---\n## Log';
  const rendered = renderTemplate(template, ctx);

  it('merges the frontmatter and inserts the body at the cursor, as one change set', () => {
    const note = '---\ntags: [daily]\nmood: ok\n---\nBody';
    const ins = templateInsertion(note, rendered, { from: note.length, to: note.length });
    const result = apply(note, ins.changes);
    expect(result).toBe('---\ntags: [daily, journal]\nmood: ok\ncreated: "2026-10-16"\n---\nBody## Log');
    expect(result.slice(ins.cursor - '## Log'.length, ins.cursor)).toBe('## Log');
  });

  it('adds the template frontmatter to a note without one, and moves an insertion point out of the frontmatter', () => {
    expect(apply('Text', templateInsertion('Text', rendered, { from: 0, to: 0 }).changes)).toBe(
      '---\ntags: [journal, Daily]\nmood: great\ncreated: "2026-10-16"\n---\n## LogText',
    );
    const note = '---\nmood: ok\n---\nBody';
    expect(apply(note, templateInsertion(note, '## Log', { from: 5, to: 5 }).changes)).toBe('---\nmood: ok\n---\n## LogBody');
  });

  it('replaces the selection and skips the properties of a note whose YAML is invalid', () => {
    const note = '---\na: [x\n---\nHello world';
    const from = note.indexOf('world');
    const ins = templateInsertion(note, rendered, { from, to: from + 5 });
    expect(ins.frontmatterSkipped).toBe(true);
    expect(apply(note, ins.changes)).toBe('---\na: [x\n---\nHello ## Log');
  });
});

describe('insertion point of a session (DESIGN §6.12)', () => {
  async function session(text: string) {
    const vault = new MockVault(false);
    vault.createFile({ path: 'n.md', content: text }, 'other-device-1');
    const s = new DocumentSession('n.md', sessionDeps(fakeApi(vault).api));
    await s.ready;
    return s;
  }

  it('goes at the end when the note was never in an editor during this page load', async () => {
    const s = await session('one\ntwo');
    expect(s.insertionRange()).toEqual({ from: 7, to: 7 });
    s.dispose();
  });

  it('uses the selection the editor kept after blur, as one undoable transaction', async () => {
    const s = await session('one\ntwo');
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({ state: s.prepareState((st) => st), parent });
    s.attach(view);
    view.dispatch({ selection: EditorSelection.single(2, 5) });
    view.contentDOM.blur();
    s.detach(view);
    view.destroy();
    expect(s.insertionRange()).toEqual({ from: 2, to: 5 });
    const ins = templateInsertion(s.getText(), '---\ntags: [x]\n---\nX', s.insertionRange());
    s.applyEdit(ins.changes, { selection: { anchor: ins.cursor } });
    expect(s.getText()).toBe('---\ntags: [x]\n---\nonXwo');
    expect(s.editorState.selection.main.head).toBe(ins.cursor);
    expect(s.getSnapshot().status).toBe('dirty');
    let state = s.editorState;
    undo({ state, dispatch: (tr) => (state = tr.state) });
    expect(state.doc.toString()).toBe('one\ntwo');
    s.dispose();
  });
});
