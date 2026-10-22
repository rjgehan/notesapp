// Wide blocks scroll sideways inside their own box (DESIGN §6.6.1, §6.7.1): their width must not
// count toward the note's width, or Live Preview's editor grows past a phone's screen and the text
// on every line is cut off at the right edge.
import { beforeAll, describe, expect, it } from 'vitest';
import { sourceFiles } from '../test/sources';

let rich = '';
let editor = '';

const uncommented = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

beforeAll(async () => {
  const files = await sourceFiles('.css');
  rich = uncommented(files['styles/rich.css']);
  editor = uncommented(files['styles/editor.css']);
});

function body(sheet: string, selector: string): string {
  for (const m of sheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (m[1].split(',').map((s) => s.trim()).includes(selector)) return m[2];
  }
  return '';
}

describe('wide blocks on a phone', () => {
  it('the note editor’s wrapped content is never wider than the note, whatever its widgets hold', () => {
    expect(body(editor, '.note-editor .cm-editor .cm-content.cm-lineWrapping')).toMatch(/min-width:\s*0/);
  });

  it('a Mermaid diagram scrolls in its own box without widening the note', () => {
    expect(body(rich, '.mermaid-block > .mermaid-svg')).toMatch(/overflow-x:\s*auto/);
    expect(body(rich, '.mermaid-block > .mermaid-svg')).toMatch(/contain:\s*inline-size/);
  });

  it('a display formula too', () => {
    expect(body(rich, '.markdown-rendered .math-block')).toMatch(/contain:\s*inline-size/);
  });
});
