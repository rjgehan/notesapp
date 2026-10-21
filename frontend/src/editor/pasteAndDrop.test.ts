import { undo } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { destroyEditors, marked, noteEditor, parsed } from '../test/noteEditor';
import { tableBlocks } from './livePreview/table';
import { blockSafePaste, inspectHtml, loadHtmlConverter } from './pasteAndDrop';

beforeAll(async () => {
  await loadHtmlConverter();
});

afterEach(() => {
  destroyEditors();
  vi.restoreAllMocks();
});

/** Pastes clipboard data into the editor, as the browser's paste event delivers it. */
function paste(view: EditorView, data: Record<string, string>, files: File[] = []): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => data[type] ?? '', files, types: Object.keys(data) } });
  view.contentDOM.dispatchEvent(event);
  return event;
}

const png = () => new File(['png'], 'image.png', { type: 'image/png' });

describe('rich paste (ROADMAP 10a)', () => {
  it('converts pasted HTML to Markdown, as one undo step', () => {
    const view = noteEditor('Start: ‸');
    paste(view, { 'text/html': '<p><strong>Bold</strong> and <a href="https://x.y">link</a></p>', 'text/plain': 'Bold and link' });
    expect(marked(view)).toBe('Start: **Bold** and [link](https://x.y)‸');
    undo(view);
    expect(view.state.doc.toString()).toBe('Start: ');
  });

  it('converts in source mode too', () => {
    const view = noteEditor('‸', { mode: 'source' });
    paste(view, { 'text/html': '<ul><li>a</li><li><em>b</em></li></ul>', 'text/plain': 'a\nb' });
    expect(view.state.doc.toString()).toBe('- a\n- *b*');
  });

  it('pastes plain text as it is', () => {
    const view = noteEditor('‸');
    paste(view, { 'text/plain': '*not* converted # and [[kept]]' });
    expect(view.state.doc.toString()).toBe('*not* converted # and [[kept]]');
  });

  it('pastes HTML without formatting as its plain text', () => {
    const view = noteEditor('‸');
    paste(view, { 'text/html': '<p>just text_with_underscores</p>', 'text/plain': 'just text_with_underscores' });
    expect(view.state.doc.toString()).toBe('just text_with_underscores');
  });

  it('Mod-Shift-V pastes plain text even when the clipboard has HTML', () => {
    const view = noteEditor('‸');
    view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'V', ctrlKey: true, shiftKey: true, bubbles: true }));
    paste(view, { 'text/html': '<p><strong>Bold</strong></p>', 'text/plain': 'Bold' });
    expect(view.state.doc.toString()).toBe('Bold');
    // Only that paste: the next one converts again.
    paste(view, { 'text/html': '<p><strong>B</strong></p>', 'text/plain': 'B' });
    expect(view.state.doc.toString()).toBe('Bold**B**');
  });

  it('pastes a code editor’s copy (a monospace block of coloured spans) as its text', () => {
    const html = '<meta charset="utf-8"><div style="color: #d4d4d4;background-color: #1e1e1e;font-family: Consolas, \'Courier New\', monospace;font-weight: normal;font-size: 14px;line-height: 19px;white-space: pre;"><div><span style="color: #569cd6;">const</span><span style="color: #d4d4d4;"> a_b = </span><span style="color: #b5cea8;font-style: italic;">1</span><span style="color: #d4d4d4;">;</span></div></div>';
    expect(inspectHtml(html).rich).toBe(false);
    const view = noteEditor('‸');
    paste(view, { 'text/html': html, 'text/plain': 'const a_b = 1;' });
    expect(view.state.doc.toString()).toBe('const a_b = 1;');
  });

  it('keeps using the attachment upload for a copied picture', () => {
    const insertFiles = vi.fn();
    const view = noteEditor('a ‸', { ctx: { insertFiles } });
    paste(view, {}, [png()]);
    expect(insertFiles).toHaveBeenCalledOnce();
    // A browser's "Copy image" also puts an <img> on the clipboard: still a picture.
    paste(view, { 'text/html': '<img src="https://example.com/a.png">' }, [png()]);
    expect(insertFiles).toHaveBeenCalledTimes(2);
    expect(view.state.doc.toString()).toBe('a ');
  });

  it('pastes the text of a Word or Excel copy, not the picture of it that comes along', () => {
    const insertFiles = vi.fn();
    const view = noteEditor('‸', { ctx: { insertFiles } });
    paste(view, { 'text/html': '<table><tr><td>Name</td><td>Age</td></tr><tr><td>Ann</td><td>31</td></tr></table>', 'text/plain': 'Name\tAge\nAnn\t31' }, [png()]);
    expect(insertFiles).not.toHaveBeenCalled();
    expect(view.state.doc.toString()).toBe('| Name | Age |\n| --- | --- |\n| Ann | 31  |');
    parsed(view);
    expect(tableBlocks(view.state)).toHaveLength(1);
  });

  it('keeps pasted blocks apart from the text around them', () => {
    const view = noteEditor('before‸after');
    paste(view, { 'text/html': '<h2>Head</h2><ul><li>item</li></ul>', 'text/plain': 'Head\nitem' });
    expect(view.state.doc.toString()).toBe('before\n\n## Head\n\n- item\n\nafter');
  });

  it('pastes the plain text when the HTML converts to nothing', () => {
    const view = noteEditor('‸');
    paste(view, { 'text/html': '<b><script>x()</script></b><a href="javascript:void(0)"></a>', 'text/plain': 'fallback' });
    expect(view.state.doc.toString()).toBe('fallback');
  });

  it('keeps a pasted rule from turning the paragraph above into a heading', () => {
    const view = noteEditor('Para\n‸');
    paste(view, { 'text/html': '<hr><p>x</p>', 'text/plain': 'x' });
    expect(view.state.doc.toString()).toBe('Para\n\n---\n\nx');
    parsed(view);
    expect(syntaxTree(view.state).topNode.getChild('SetextHeading2')).toBeNull();
  });

  it('pastes plain text into a code block, inline code and the properties', () => {
    const html = { 'text/html': '<p><strong>Bold</strong> [x]</p>', 'text/plain': 'Bold [x]' };
    for (const doc of ['```\n‸\n```', '    code‸', 'a `in‸line` b', '---\ntitle: ‸\n---\n']) {
      const view = noteEditor(doc, { mode: 'source' });
      const at = view.state.selection.main.head;
      paste(view, html);
      expect(view.state.sliceDoc(at, at + 8), doc).toBe('Bold [x]');
    }
    // Right after inline code, it converts.
    const view = noteEditor('a `code`‸');
    paste(view, html);
    expect(view.state.doc.toString()).toBe('a `code`**Bold** [x]');
  });

  it('does nothing in a locked note', () => {
    const view = noteEditor('‸text', { mode: 'locked' });
    paste(view, { 'text/html': '<p><b>x</b></p>', 'text/plain': 'x' });
    expect(view.state.doc.toString()).toBe('text');
  });
});

describe('blockSafePaste', () => {
  it('puts a table under a paragraph on a line apart, and inline text inline', () => {
    const view = noteEditor('Para\n‸');
    const at = view.state.selection.main.head;
    expect(blockSafePaste(view.state, at, at, '| a |\n| - |')).toBe('\n| a |\n| - |');
    expect(blockSafePaste(view.state, at, at, '**x**')).toBe('**x**');
  });

  it('puts a rule on a line apart, never under a paragraph, and keeps the text after it apart', () => {
    const view = noteEditor('Para‸ end\n');
    const at = view.state.selection.main.head;
    expect(blockSafePaste(view.state, at, at, '---\n\nx')).toBe('\n\n---\n\nx');
    expect(blockSafePaste(view.state, at, at, 'x\n\n---')).toBe('x\n\n---\n\n');
    const under = noteEditor('Para\n‸');
    const end = under.state.selection.main.head;
    expect(blockSafePaste(under.state, end, end, '---')).toBe('\n---');
  });
});
