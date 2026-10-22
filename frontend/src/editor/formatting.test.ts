import { undo } from '@codemirror/commands';
import { Transaction } from '@codemirror/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { destroyEditors, marked, noteEditor, parsed, press, typeText } from '../test/noteEditor';
import { cycleHeading, hasFormat, inLink, pendingFormats, toggleBulletList, toggleFormat, toggleHeading, toggleLink, toggleNumberedList, toggleQuote, type InlineFormat } from './formatting';
import { collectElements } from './livePreview/model';

afterEach(() => {
  destroyEditors();
  vi.restoreAllMocks();
});

const KEYS: Record<InlineFormat, [string, { ctrlKey: boolean; shiftKey?: boolean }]> = {
  strong: ['b', { ctrlKey: true }],
  emphasis: ['i', { ctrlKey: true }],
  strikethrough: ['x', { ctrlKey: true, shiftKey: true }],
  highlight: ['h', { ctrlKey: true, shiftKey: true }],
  code: ['e', { ctrlKey: true }],
};

/** Toggles `format` with its key on the marked text, and returns the marked result. */
function toggle(text: string, format: InlineFormat, mode: 'live' | 'source' = 'live'): string {
  const view = noteEditor(text, { mode });
  const [key, mods] = KEYS[format];
  expect(press(view, key, mods)).toBe(true);
  return marked(view);
}

function kinds(text: string): string[] {
  const view = noteEditor(text);
  return collectElements(view.state, [{ from: 0, to: view.state.doc.length }]).map((e) => `${e.kind}:${view.state.sliceDoc(e.textFrom, e.textTo)}`);
}

describe('formatting keys on a selection (ROADMAP 10a)', () => {
  it('each key wraps the selection in its markers and keeps it selected', () => {
    expect(toggle('a «word» b', 'strong')).toBe('a **«word»** b');
    expect(toggle('a «word» b', 'emphasis')).toBe('a *«word»* b');
    expect(toggle('a «word» b', 'strikethrough')).toBe('a ~~«word»~~ b');
    expect(toggle('a «word» b', 'highlight')).toBe('a ==«word»== b');
    expect(toggle('a «word» b', 'code')).toBe('a `«word»` b');
  });

  it('each key takes its format off text that has it', () => {
    expect(toggle('a **«word»** b', 'strong')).toBe('a «word» b');
    expect(toggle('a *«word»* b', 'emphasis')).toBe('a «word» b');
    expect(toggle('a ~~«word»~~ b', 'strikethrough')).toBe('a «word» b');
    expect(toggle('a ==«word»== b', 'highlight')).toBe('a «word» b');
    expect(toggle('a `«word»` b', 'code')).toBe('a «word» b');
    // The markers selected too (source mode).
    expect(toggle('a «**word**» b', 'strong', 'source')).toBe('a «word» b');
  });

  it('a selection made backwards stays backwards', () => {
    expect(toggle('a »word« b', 'strong')).toBe('a **»word«** b');
  });

  it('leaves the blanks at the ends of a selection outside the markers', () => {
    expect(toggle('«word »next', 'strong')).toBe('**«word** »next');
  });

  it('takes the format off part of formatted text, which stays formatted around it', () => {
    expect(toggle('**ab«cd»ef**', 'strong')).toBe('**ab**«cd»**ef**');
    expect(toggle('**«ab»cd**', 'strong')).toBe('«ab»**cd**');
    expect(toggle('**ab«cd»**', 'strong')).toBe('**ab**«cd»');
    expect(toggle('**one «two» three**', 'strong')).toBe('**one** «two» **three**');
    // Underscores cannot close inside a word, so the split writes asterisks.
    expect(toggle('__ab«cd»ef__', 'strong')).toBe('**ab**«cd»**ef**');
  });

  it('formats text that is formatted only in part, merging with it', () => {
    expect(toggle('a «b **c** d» e', 'strong')).toBe('a **«b c d»** e');
    expect(toggle('**a**«b»', 'strong')).toBe('**a«b»**');
    expect(toggle('«x **y»z**', 'strong')).toBe('**«x y»z**');
  });

  it('nests with other formatting whose edge the selection crosses', () => {
    const out = toggle('*one «two* three»', 'strong');
    expect(out).toBe('*one **«two*** **three»**');
    expect(kinds(out.replace(/[«»]/g, ''))).toEqual(expect.arrayContaining(['strong:two', 'strong:three', 'emphasis:one **two**']));
    expect(toggle('[link «text](https://x.y) more»', 'strong')).toBe('[link **«text**](https://x.y) **more»**');
  });

  it('never cuts into code, wikilinks or addresses: they are formatted whole', () => {
    expect(toggle('see `co«de` and» x', 'strong', 'source')).toBe('see **`co«de` and»** x');
    expect(toggle('see [[No«te]] x»', 'strong', 'source')).toBe('see **[[No«te]] x»**');
  });

  it('formats line by line, leaving block markup and code blocks alone', () => {
    expect(toggle('«- one\n- two»', 'strong')).toBe('«- **one**\n- **two»**');
    expect(toggle('«# Title»', 'emphasis', 'source')).toBe('«# *Title»*');
    expect(toggle('«> quoted\n> text»', 'highlight', 'source')).toBe('«> ==quoted==\n> ==text»==');
    expect(toggle('«para\n```\ncode\n```»', 'strong', 'source')).toBe('**«para**\n```\ncode\n```»');
  });

  it('inline code gets enough backticks for the text, and strips formatting inside it', () => {
    expect(toggle('«a`b»', 'code')).toBe('``«a`b»``');
    expect(toggle('«`x`y»', 'code', 'source')).toBe('`«xy»`');
    expect(toggle('«a **b** c»', 'code')).toBe('`«a b c»`');
  });

  it('a toggle is one undo step', () => {
    const view = noteEditor('a «word» b');
    press(view, 'b', { ctrlKey: true });
    expect(view.state.doc.toString()).toBe('a **word** b');
    undo(view);
    expect(view.state.doc.toString()).toBe('a word b');
  });

  it('hasFormat says whether all the selected text has the format', () => {
    let view = noteEditor('**«all»**');
    expect(hasFormat(view.state, view.state.selection.main, 'strong')).toBe(true);
    view = noteEditor('**some** «of **it»**');
    expect(hasFormat(view.state, view.state.selection.main, 'strong')).toBe(false);
    view = noteEditor('**in‸side**');
    expect(hasFormat(view.state, view.state.selection.main, 'strong')).toBe(true);
    expect(hasFormat(view.state, view.state.selection.main, 'emphasis')).toBe(false);
  });

  it('formats a whole long note at once, and takes it off again, without slowing down', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => (i % 2 ? '' : `- item ${i} has **bold**, *it*, \`code\` and [[Note]]`));
    const view = noteEditor(lines.join('\n'));
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
    let started = performance.now();
    press(view, 'b', { ctrlKey: true });
    expect(performance.now() - started).toBeLessThan(3000);
    const out = view.state.doc.toString().split('\n');
    expect(out[0]).toBe('- **item 0 has bold, *it*, `code` and [[Note]]**');
    expect(out.filter((l) => l !== '').every((l) => l.startsWith('- **') && l.endsWith('**'))).toBe(true);
    // All of it is bold now (the selection stays on it): the same key takes it off everywhere.
    parsed(view);
    expect(hasFormat(view.state, view.state.selection.main, 'strong')).toBe(true);
    started = performance.now();
    press(view, 'b', { ctrlKey: true });
    expect(performance.now() - started).toBeLessThan(3000);
    expect(view.state.doc.toString().split('\n')[0]).toBe('- item 0 has bold, *it*, `code` and [[Note]]');
    expect(view.state.doc.toString()).not.toContain('**');
  });

  it('sees formatting that runs over a line break', () => {
    expect(toggle('a **«b\nc»** d', 'strong')).toBe('a «b\nc» d');
    // New formatting goes on line by line.
    expect(toggle('**a\nb** «c\nd»', 'strong')).toBe('**a\nb** **«c**\n**d»**');
  });

  it('reads the formatting of a selection that reaches past the parsed part of the note', () => {
    // A new editor state is parsed only to its first few thousand characters; the rest is parsed
    // in the background. Bold text further down must not be taken for plain text.
    const lines = Array.from({ length: 3000 }, (_, i) => `**line ${i}**`);
    const view = noteEditor(`«${lines.join('\n')}»`, { partial: true });
    expect(hasFormat(view.state, view.state.selection.main, 'strong')).toBe(true);
    press(view, 'b', { ctrlKey: true });
    expect(view.state.doc.toString()).toBe(Array.from({ length: 3000 }, (_, i) => `line ${i}`).join('\n'));
  });

  it('does nothing in a locked note', () => {
    const view = noteEditor('a «word» b', { mode: 'locked' });
    press(view, 'b', { ctrlKey: true });
    expect(view.state.doc.toString()).toBe('a word b');
  });
});

describe('formatting keys at the cursor (ROADMAP 10a)', () => {
  it('at the end of formatted text the cursor steps out of it, so typing goes on unformatted', () => {
    const view = noteEditor('**bold‸** x');
    press(view, 'b', { ctrlKey: true });
    expect(marked(view)).toBe('**bold**‸ x');
    typeText(view, 'y');
    expect(view.state.doc.toString()).toBe('**bold**y x');
  });

  it('at the start of formatted text the cursor steps in front of it', () => {
    const view = noteEditor('x ==‸mark==');
    press(view, 'h', { ctrlKey: true, shiftKey: true });
    expect(marked(view)).toBe('x ‸==mark==');
  });

  it('inside formatted text the format comes off', () => {
    expect(toggle('**bo‸ld**', 'strong')).toBe('bo‸ld');
    expect(toggle('a `co‸de` b', 'code')).toBe('a co‸de b');
  });

  it('inside a word the word gets the format', () => {
    expect(toggle('a wo‸rd b', 'strong')).toBe('a **wo‸rd** b');
    expect(toggle('a wo‸rd b', 'code')).toBe('a `wo‸rd` b');
  });

  it('elsewhere the format applies to what is typed next, and nothing is written before', () => {
    const view = noteEditor('word ‸');
    press(view, 'b', { ctrlKey: true });
    expect(view.state.doc.toString()).toBe('word ');
    expect(view.state.field(pendingFormats)).toEqual({ pos: 5, formats: ['strong'] });
    expect(view.dom.querySelector('.cm-pending-format')?.textContent).toBe('B');
    typeText(view, 'xy');
    expect(marked(view)).toBe('word **xy‸**');
    expect(view.dom.querySelector('.cm-pending-format')).toBeNull();
    // Mod-B again steps out, and typing goes on plain.
    press(view, 'b', { ctrlKey: true });
    typeText(view, 'z');
    expect(view.state.doc.toString()).toBe('word **xy**z');
  });

  it('formats switched on together nest, and blanks typed first move them along', () => {
    const view = noteEditor('‸');
    press(view, 'b', { ctrlKey: true });
    press(view, 'i', { ctrlKey: true });
    typeText(view, ' x');
    expect(marked(view)).toBe(' ***x‸***');
  });

  it('a format switched on and off again leaves typing plain', () => {
    const view = noteEditor('a ‸');
    press(view, 'b', { ctrlKey: true });
    press(view, 'b', { ctrlKey: true });
    expect(view.state.field(pendingFormats)).toBeNull();
    typeText(view, 'x');
    expect(view.state.doc.toString()).toBe('a x');
  });

  it('moving the cursor forgets a pending format', () => {
    const view = noteEditor('ab ‸');
    press(view, 'b', { ctrlKey: true });
    view.dispatch({ selection: { anchor: 0 } });
    expect(view.state.field(pendingFormats)).toBeNull();
  });

  it('an unused toggle on an empty line writes nothing that could change the note (no `~~~~` fence, no `====` heading)', () => {
    for (const [format, key] of [
      ['strikethrough', 'x'],
      ['highlight', 'h'],
    ] as const) {
      const view = noteEditor('Para\n‸');
      press(view, key, { ctrlKey: true, shiftKey: true });
      expect(view.state.doc.toString()).toBe('Para\n');
      expect(hasFormat(view.state, view.state.selection.main, format)).toBe(true);
    }
  });

  it('another device’s edit moves a pending format along with the cursor', () => {
    const view = noteEditor('abc ‸');
    press(view, 'b', { ctrlKey: true });
    view.dispatch({ changes: { from: 0, insert: 'NEW ' }, annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)] });
    expect(view.state.field(pendingFormats)?.pos).toBe(8);
    typeText(view, 'x');
    expect(view.state.doc.toString()).toBe('NEW abc **x**');
  });

  it('leaves frontmatter and unclosed formatting readable', () => {
    expect(toggle('---\na: «b»\n---\n', 'strong')).toBe('---\na: «b»\n---\n');
    // An unclosed `**` is text: the selection gets its own markers.
    expect(toggle('**«bold»', 'strong', 'source')).toBe('****«bold»**');
  });

  it('works the same in source mode', () => {
    expect(toggle('a wo‸rd b', 'emphasis', 'source')).toBe('a *wo‸rd* b');
    expect(toggle('*it‸* b', 'emphasis', 'source')).toBe('*it*‸ b');
  });
});

describe('Mod-E (ROADMAP 10a)', () => {
  it('toggles inline code while editing', () => {
    const view = noteEditor('a wo‸rd');
    press(view, 'e', { ctrlKey: true });
    expect(view.state.doc.toString()).toBe('a `word`');
  });

  it('does nothing in a note that cannot be written (it switches no mode)', () => {
    const view = noteEditor('a word', { mode: 'locked' });
    press(view, 'e', { ctrlKey: true });
    expect(view.state.doc.toString()).toBe('a word');
  });
});

describe('links (Mod-K)', () => {
  const link = (text: string) => {
    const view = noteEditor(text);
    expect(press(view, 'k', { ctrlKey: true })).toBe(true);
    return marked(view);
  };

  it('selected text becomes the text of a link, with the cursor where the address goes', () => {
    expect(link('see «docs» now')).toBe('see [docs](‸) now');
    expect(link('a wo‸rd')).toBe('a [word](‸)');
    expect(link('a ‸')).toBe('a [‸]()');
  });

  it('a selected address becomes the address of a link, with the cursor on its text', () => {
    expect(link('«https://example.com/a»')).toBe('[‸](https://example.com/a)');
    expect(link('go https://example.com/a‸')).toBe('go [‸](https://example.com/a)');
  });

  it('in a link it takes the link off and keeps the text', () => {
    expect(link('a [te‸xt](https://x.y) b')).toBe('a te‸xt b');
    expect(link('a [[Note|al‸ias]] b')).toBe('a alias‸ b');
    expect(link('a [[No‸te#Part]] b')).toBe('a Note > Part‸ b');
    expect(link('a <https://x.y‸> b')).toBe('a https://x.y‸ b');
  });

  it('inLink tells the toolbar whether the selection is a link', () => {
    const view = noteEditor('[te«xt»](https://x.y) b');
    expect(inLink(view.state, view.state.selection.main)).toBe(true);
    toggleLink(view);
    expect(view.state.doc.toString()).toBe('text b');
  });
});

describe('heading, list and quote commands (palette, toolbars)', () => {
  const run = (text: string, command: (v: ReturnType<typeof noteEditor>) => boolean, mode: 'live' | 'source' = 'source', partial = false) => {
    const view = noteEditor(text, { mode, partial });
    command(view);
    // A selection's lines are compared by their text.
    return text.includes('«') ? view.state.doc.toString() : marked(view);
  };

  it('toggles heading levels, a heading replacing a list marker', () => {
    expect(run('Ti‸tle', toggleHeading(2))).toBe('## Ti‸tle');
    expect(run('## Ti‸tle', toggleHeading(2))).toBe('Ti‸tle');
    expect(run('# Ti‸tle', toggleHeading(3))).toBe('### Ti‸tle');
    expect(run('- it‸em', toggleHeading(1))).toBe('# it‸em');
    expect(run('> quo‸te', toggleHeading(1))).toBe('> # quo‸te');
    expect(run('«a\n\nb»', toggleHeading(1))).toBe('# a\n\n# b');
  });

  it('the phone toolbar cycles text, heading 1, 2, 3 and back', () => {
    const view = noteEditor('‸', { mode: 'source' });
    const seen: string[] = [];
    for (let i = 0; i < 4; i++) {
      cycleHeading(view);
      seen.push(view.state.doc.toString());
    }
    expect(seen).toEqual(['# ', '## ', '### ', '']);
  });

  it('in Live Preview the cursor stays where the text starts', () => {
    expect(run('‸', toggleHeading(1), 'live')).toBe('# ‸');
    expect(run('a‸', toggleBulletList, 'live')).toBe('- a‸');
  });

  it('toggles bulleted and numbered lists', () => {
    expect(run('«a\nb»', toggleBulletList)).toBe('- a\n- b');
    expect(run('«- a\n- b»', toggleBulletList)).toBe('a\nb');
    expect(run('«1. a\n2. b»', toggleBulletList)).toBe('- a\n- b');
    expect(run('«a\nb»', toggleNumberedList)).toBe('1. a\n2. b');
    expect(run('«1. a\n2. b»', toggleNumberedList)).toBe('a\nb');
    // A numbered list above continues.
    expect(run('1. x\n‸y', toggleNumberedList)).toBe('1. x\n2. ‸y');
    // A task made a bullet loses its box.
    expect(run('- [ ] t‸', toggleBulletList)).toBe('- t‸');
  });

  it('toggles quotes, blank lines inside included', () => {
    expect(run('«a\n\nb»', toggleQuote)).toBe('> a\n>\n> b');
    expect(run('«> a\n>\n> b»', toggleQuote)).toBe('a\n\nb');
  });

  it('leaves code blocks and frontmatter alone', () => {
    expect(run('«```\ncode\n```»', toggleBulletList)).toBe('```\ncode\n```');
    expect(run('«---\na: 1\n---\ntext»', toggleQuote)).toBe('---\na: 1\n---\n> text');
    // A blank line in the frontmatter stays blank (a `>` there would break the YAML).
    expect(run('«---\na: 1\n\nb: 2\n---\ntext»', toggleQuote)).toBe('---\na: 1\n\nb: 2\n---\n> text');
  });

  it('leaves code blocks alone past the parsed part of a long note', () => {
    const body = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n');
    const out = run(`«${body}\n\`\`\`\ncode\n\`\`\`»`, toggleBulletList, 'source', true);
    expect(out.endsWith('- line 1999\n```\ncode\n```')).toBe(true);
  });

  it('formats through the generic command too', () => {
    expect(run('«x»', toggleFormat('strong'))).toBe('**x**');
  });
});
