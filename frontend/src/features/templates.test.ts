import { undo } from '@codemirror/commands';
import { EditorSelection, Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';
import { MockVault } from '../api/mock/vault';
import { DocumentSession } from '../sync/DocumentSession';
import { fakeApi, sessionDeps } from '../test/fakes';
import { dayjs } from './dates';
import { useDialogs } from '../state/dialogs';
import { askPrompts, mergeFrontmatter, renderTemplate, renderTemplateOutput, templateInsertion, templatePrompts } from './templates';

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

describe('Templates v2 placeholders (ROADMAP item 30)', () => {
  it('removes {{cursor}} and reports where the first one was', () => {
    expect(renderTemplateOutput('# {{title}}\n\n{{cursor}}\n- {{ CURSOR }}', ctx)).toEqual({ text: '# Plan\n\n\n- ', cursor: 8 });
    expect(renderTemplateOutput('No caret', ctx)).toEqual({ text: 'No caret', cursor: null });
    expect(renderTemplate('a{{cursor}}b', ctx)).toBe('ab');
  });

  it('renders prompts from the answers, else their default, and never renders an answer again', () => {
    const tpl = 'Who: {{prompt:Attendees}}\nMood: {{ prompt: Mood | fine }}\nAgain: {{prompt:Attendees|ignored}}';
    // Unanswered (as in a capture's daily note on the server), each renders its own default.
    expect(renderTemplate(tpl, ctx)).toBe('Who: \nMood: fine\nAgain: ignored');
    expect(renderTemplate(tpl, { ...ctx, answers: { Attendees: 'Ann {{title}}', Mood: '' } })).toBe('Who: Ann {{title}}\nMood: \nAgain: Ann {{title}}');
  });

  it('lists each question once, with its first default', () => {
    expect(templatePrompts('{{prompt:Topic}} {{prompt:Mood|ok}} {{prompt:Topic|x}} {{prompt:}} {{prompt: Mood |bad}}')).toEqual([
      { question: 'Topic', initial: '' },
      { question: 'Mood', initial: 'ok' },
    ]);
    expect(templatePrompts('# {{title}} {{date}}')).toEqual([]);
  });

  it('keeps the Obsidian core syntax and leaves look-alikes alone', () => {
    expect(renderTemplate('{{prompt:}} {{cursor:1}} {{prompts:x}} {{titles}}', ctx)).toBe('{{prompt:}} {{cursor:1}} {{prompts:x}} {{titles}}');
  });

  it('asks the questions in one dialog; cancelling resolves null', async () => {
    const asked = askPrompts('{{prompt:Topic}} {{prompt:Mood|ok}}', 'Meeting');
    const request = useDialogs.getState().stack.at(-1);
    expect(request?.kind).toBe('fields');
    if (request?.kind !== 'fields') return;
    expect(request.title).toBe('Meeting');
    expect(request.fields).toEqual([
      { label: 'Topic', value: '' },
      { label: 'Mood', value: 'ok' },
    ]);
    request.resolve(['Roadmap', 'great']);
    await expect(asked).resolves.toEqual({ Topic: 'Roadmap', Mood: 'great' });
    const cancelled = askPrompts('{{prompt:Topic}}', 'Meeting');
    const second = useDialogs.getState().stack.at(-1);
    if (second?.kind === 'fields') second.resolve(null);
    await expect(cancelled).resolves.toBeNull();
    await expect(askPrompts('No questions', 'Plain')).resolves.toEqual({});
  });

  it("puts the caret at the template's {{cursor}} in the inserted body", () => {
    const out = renderTemplateOutput('---\ntags: [x]\n---\n## Log\n{{cursor}}\nEnd', ctx);
    const note = 'Text';
    const ins = templateInsertion(note, out.text, { from: 4, to: 4 }, out.cursor);
    const result = apply(note, ins.changes);
    expect(result).toBe('---\ntags: [x]\n---\nText## Log\n\nEnd');
    expect(result.slice(0, ins.cursor)).toBe('---\ntags: [x]\n---\nText## Log\n');
    // A {{cursor}} in the frontmatter does not count: the caret goes after the body.
    const inYaml = renderTemplateOutput('---\na: {{cursor}}1\n---\nB', ctx);
    expect(templateInsertion('', inYaml.text, { from: 0, to: 0 }, inYaml.cursor).cursor).toBe('---\na: 1\n---\nB'.length);
  });
});
