import { describe, expect, it } from 'vitest';
import { httpEndpoints } from '../api/endpoints';
import type { FileEntry } from '../api/types';
import { registerBuiltins } from '../extensions/builtins';
import { buildLinkIndex, resolve } from '../features/links';
import { basenameOf, extensionOf, lastSegment } from '../features/paths';
import { patchChildren } from './patch';
import { embeddedPart, extractSection, lineHash, onlyCheckboxesChanged, renderNote, renderNoteHtml, toggleTaskAtLine, type RenderContext } from './render';

function entry(path: string, size = 100): FileEntry {
  const ext = extensionOf(path);
  return {
    path,
    name: lastSegment(path),
    basename: basenameOf(path),
    extension: ext,
    kind: ext === 'md' ? 'note' : ext === 'png' ? 'image' : ext === 'pdf' ? 'pdf' : ext === 'mp4' ? 'video' : 'other',
    size,
    mtime: '2026-10-16T14:03:22.120Z',
    version: null,
    aliases: [],
  };
}

const FILES = ['Welcome.md', 'Plan.md', 'Projects/Plan.md', 'Ideas/Plan B.md', 'Attachments/pic.png', 'Docs/manual.pdf', 'Clips/demo.mp4', 'data.zip'].map((p) => entry(p));
const byPath = new Map(FILES.map((f) => [f.path, f]));
const index = buildLinkIndex(byPath.keys());

function ctx(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    sourcePath: 'Welcome.md',
    resolve: (t) => {
      const p = resolve(t, 'Welcome.md', index);
      return p ? (byPath.get(p) ?? null) : null;
    },
    rawUrl: (e) => httpEndpoints.rawUrl(e),
    strictLineBreaks: false,
    loadRemoteImages: true,
    depth: 0,
    ...overrides,
  };
}

function dom(text: string, c: RenderContext = ctx()): HTMLElement {
  const div = document.createElement('div');
  div.appendChild(renderNote(text, c).fragment);
  return div;
}

describe('render: links', () => {
  it('renders wikilinks with display text, subpaths and resolution', () => {
    const el = dom('See [[Plan]], [[Plan B|the alternative]] and [[Plan#Goals]].');
    const links = [...el.querySelectorAll('a.internal-link')];
    expect(links.map((a) => a.textContent)).toEqual(['Plan', 'the alternative', 'Plan > Goals']);
    expect(links.map((a) => a.getAttribute('data-href'))).toEqual(['Plan', 'Plan B', 'Plan#Goals']);
    expect(links[1].getAttribute('href')).toBe('/n/Ideas/Plan%20B.md');
    expect(links[2].getAttribute('href')).toBe('/n/Plan.md#Goals');
  });

  it('marks unresolved links on the first render', () => {
    const el = dom('[[Missing]] and [x](Nowhere.md)');
    expect([...el.querySelectorAll('a.is-unresolved')].map((a) => a.textContent)).toEqual(['Missing', 'x']);
  });

  it('handles the table escape \\| as the alias separator', () => {
    const el = dom('| a | b |\n|---|---|\n| [[Plan\\|alias]] | x |');
    const a = el.querySelector('td a.internal-link');
    expect(a?.textContent).toBe('alias');
    expect(a?.getAttribute('data-href')).toBe('Plan');
  });

  it('resolves internal markdown links and keeps + in destinations', () => {
    const el = dom('[alt](Ideas/Plan%20B.md#Risks) and [ext](https://example.com)');
    const [internal, external] = [...el.querySelectorAll('a')];
    expect(internal.classList.contains('internal-link')).toBe(true);
    expect(internal.getAttribute('data-href')).toBe('Ideas/Plan B.md#Risks');
    expect(external.getAttribute('target')).toBe('_blank');
    expect(external.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('render: tags (API.md §15.6)', () => {
  const tagsOf = (md: string) => [...dom(md).querySelectorAll('a.tag')].map((a) => a.getAttribute('data-tag'));

  it.each([
    ['#project', ['project']],
    ['#Project/Alpha', ['Project/Alpha']],
    ['#a/b/', ['a/b']],
    ['#1984', []],
    ['#y1984', ['y1984']],
    ['a#b', []],
    ['#🚀 launch', ['🚀']],
    ['#don’t', ['don’t']],
    ["#don't", ['don']],
    ['#tag.', ['tag']],
    ['# Heading #tag', ['tag']],
    ['[see #x](https://e.com)', []],
    ['`#code`', []],
  ])('%s', (input, expected) => {
    expect(tagsOf(input)).toEqual(expected);
  });
});

describe('render: blocks', () => {
  it('stamps headings with data-heading and blocks with data-line after the frontmatter', () => {
    const el = dom('---\ntags: [a]\n---\n# Title\n\nPara\n\n## Sub *x*\n');
    const h1 = el.querySelector('h1')!;
    expect(h1.getAttribute('data-heading')).toBe('Title');
    expect(h1.getAttribute('data-line')).toBe('3');
    expect(el.querySelector('p')!.getAttribute('data-line')).toBe('5');
    expect(el.querySelector('h2')!.getAttribute('data-heading')).toBe('Sub *x*');
  });

  it('renders single line breaks unless strictLineBreaks is on', () => {
    expect(dom('a\nb').querySelector('br')).not.toBeNull();
    expect(dom('a\nb', ctx({ strictLineBreaks: true })).querySelector('br')).toBeNull();
  });

  it('renders ==highlights== and footnotes', () => {
    const el = dom('A ==mark== here.[^1]\n\n[^1]: Note.');
    expect(el.querySelector('mark')?.textContent).toBe('mark');
    expect(el.querySelector('.footnotes, section.footnotes, .footnotes-list, ol.footnotes-list')).not.toBeNull();
  });

  it('hides %%comments%% inline and in block form', () => {
    const el = dom('Visible %%hidden%% text\n\n%%\nblock\n\nstill hidden\n%%\n\nAfter');
    expect(el.textContent).not.toContain('hidden');
    expect(el.textContent).toContain('Visible');
    expect(el.textContent).toContain('After');
  });

  it('shows encrypted sections as lock chips that carry only their ciphertext (item 27)', () => {
    const b64 = 'QUJDREVGR0hJSktMTU5PUA==';
    const hidden = `%%🔐β 💡pet💡${b64} 🔐%%`;
    const visible = `🔐β ${b64} 🔐`;
    const el = dom(`PIN: ${hidden} and ${visible} done.\n\n${hidden}\n\nAfter`);
    const chips = [...el.querySelectorAll<HTMLElement>('.encrypted-chip')];
    expect(chips).toHaveLength(3);
    expect(chips[0].dataset.section).toBe(hidden);
    expect(chips[0].textContent).toBe('🔒 Encrypted · pet');
    expect(chips[1].dataset.section).toBe(visible);
    expect(el.textContent).not.toContain(b64);
    expect(el.textContent).toContain('PIN:');
    expect(el.textContent).toContain('done.');
    expect(el.textContent).toContain('After');
    // An ordinary comment still hides.
    expect(dom('a %%not a section%% b').textContent).not.toContain('section');
  });
});

describe('render: embeds', () => {
  it('builds images with content-addressed URLs and sizes', () => {
    const el = dom('![[pic.png|300]] ![[pic.png|200x100]] ![[pic.png]]');
    const imgs = [...el.querySelectorAll('img')];
    expect(imgs).toHaveLength(3);
    expect(imgs[0].getAttribute('src')).toBe('/api/files/raw?path=Attachments%2Fpic.png&v=100-' + Date.parse('2026-10-16T14:03:22.120Z'));
    expect(imgs[0].getAttribute('width')).toBe('300');
    expect(imgs[1].getAttribute('height')).toBe('100');
    expect(imgs[2].parentElement?.classList.contains('is-reserving')).toBe(true);
  });

  it('renders markdown images of vault files and remote placeholders', () => {
    expect(dom('![x](Attachments/pic.png)').querySelector('img')?.getAttribute('src')).toContain('Attachments%2Fpic.png');
    const blocked = dom('![r](https://e.com/a.png)', ctx({ loadRemoteImages: false }));
    expect(blocked.querySelector('img')).toBeNull();
    expect(blocked.querySelector('.remote-image-placeholder')?.getAttribute('data-src')).toBe('https://e.com/a.png');
  });

  it('leaves placeholders for notes, pdf and media, and links at depth 1', () => {
    const el = dom('![[Plan]]\n\n![[manual.pdf#page=2]]\n\n![[demo.mp4]]\n\n![[data.zip]]');
    expect([...el.querySelectorAll('[data-embed-kind]')].map((e) => e.getAttribute('data-embed-kind'))).toEqual(['note', 'pdf', 'video', 'file']);
    expect(el.querySelector('[data-embed-kind="pdf"]')?.getAttribute('data-embed-subpath')).toBe('page=2');
    const nested = dom('![[Plan]]', ctx({ depth: 1 }));
    expect(nested.querySelector('[data-embed-kind]')).toBeNull();
    expect(nested.querySelector('a.internal-link')?.getAttribute('data-href')).toBe('Plan');
  });

  it('renders a self-embed as a link (cycle guard)', () => {
    expect(dom('![[Welcome]]').querySelector('[data-embed-kind]')).toBeNull();
  });

  it('embeds blocks of other notes and of the note itself, and links them at depth 1 (item 20)', () => {
    const el = dom('![[Plan#^abc]]\n\n![[#^own]]');
    const embeds = [...el.querySelectorAll('[data-embed-kind="note"]')];
    expect(embeds.map((e) => e.getAttribute('data-embed-subpath'))).toEqual(['^abc', '^own']);
    expect(embeds[1].getAttribute('data-embed-path')).toBe('Welcome.md');
    const nested = dom('![[Plan#^abc]]', ctx({ depth: 1 }));
    expect(nested.querySelector('[data-embed-kind]')).toBeNull();
    expect(nested.querySelector('a.internal-link')?.getAttribute('data-href')).toBe('Plan#^abc');
  });
});

describe('render: block ids (item 20)', () => {
  it('hides ids and stamps paragraphs, headings and list items with data-block-id', () => {
    const el = dom('# Title ^top\n\nSome text ^p1\n\nTwo lines\n^p2\n\n- item ^li\n- other\n');
    expect(el.textContent).not.toContain('^');
    expect(el.querySelector('h1')?.getAttribute('data-block-id')).toBe('top');
    expect(el.querySelector('h1')?.getAttribute('data-heading')).toBe('Title');
    const ps = [...el.querySelectorAll('p[data-block-id]')].map((p) => [p.getAttribute('data-block-id'), p.textContent]);
    expect(ps).toEqual([
      ['p1', 'Some text'],
      ['p2', 'Two lines'],
    ]);
    expect(el.querySelector('li')?.getAttribute('data-block-id')).toBe('li');
    expect(el.querySelector('li')?.textContent).toBe('item');
  });

  it('gives an id on its own line to the block before it and removes that line', () => {
    const el = dom('| a | b |\n|---|---|\n| 1 | 2 |\n\n^tbl\n\n> quote\n\n^q\n\n```js\nx\n```\n\n^code\n\n- a\n- b\n\n^list');
    expect(el.querySelector('table')?.getAttribute('data-block-id')).toBe('tbl');
    expect(el.querySelector('blockquote')?.getAttribute('data-block-id')).toBe('q');
    expect(el.querySelector('[data-block-id="code"]')).not.toBeNull();
    expect(el.querySelector('ul')?.getAttribute('data-block-id')).toBe('list');
    expect(el.textContent).not.toMatch(/\^(tbl|q|code|list)/);
  });

  it('leaves ids in code alone', () => {
    const el = dom('```\nlet a ^x\n```\n\n`b ^y`');
    expect(el.textContent).toContain('let a ^x');
    expect(el.textContent).toContain('b ^y');
    expect(el.querySelector('[data-block-id]')).toBeNull();
  });
});

describe('embeddedPart', () => {
  it('picks a block, a section or the whole note', () => {
    const text = '# A\n\npara ^p\n\n# B\nend';
    expect(embeddedPart(text, '^p')).toBe('para ^p');
    expect(embeddedPart(text, 'B')).toBe('# B\nend');
    expect(embeddedPart(text, null)).toBe(text);
    expect(embeddedPart(text, '^missing')).toBeNull();
  });
});

describe('render: sanitization', () => {
  it('removes scripts and event handlers', () => {
    const html = renderNoteHtml('<script>alert(1)</script><img src="x" onerror="alert(1)">', ctx());
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
  });

  it('forbids style, form and button', () => {
    const html = renderNoteHtml('<style>body{}</style><form><button>x</button></form><textarea></textarea>', ctx());
    expect(html).not.toMatch(/<(style|form|button|textarea)/);
  });

  it('strips fixed positioning and z-index', () => {
    const el = dom('<div style="position: fixed; top: 0; z-index: 9999; color: red">overlay</div>');
    const style = el.querySelector('div')!.getAttribute('style')!;
    expect(style).not.toMatch(/fixed|z-index/);
    expect(style).toContain('color');
  });

  it('strips app-reserved embed attributes from raw HTML, so a note cannot transclude itself (FE-3, ux)', () => {
    const el = dom('Loop\n\n<span data-embed-kind="note" data-embed-path="Welcome.md" data-hydrated data-app="guess"></span>\n\n<img data-embed-kind="image" data-embed-path="Attachments/pic.png">');
    expect(el.querySelector('[data-embed-kind]')).toBeNull();
    expect(el.querySelector('[data-embed-path]')).toBeNull();
    expect(el.querySelector('[data-app]')).toBeNull();
    // The renderer's own placeholders keep theirs.
    const own = dom('![[Plan]]');
    expect(own.querySelector('[data-embed-kind="note"]')?.getAttribute('data-embed-path')).toBe('Plan.md');
    expect(own.querySelector('[data-app]')).toBeNull();
  });

  it('applies "Load remote images: off" to raw HTML images, media and CSS backgrounds (FE-17, ux)', () => {
    const text =
      '<img src="https://tracker.example/p.gif" alt="pixel">\n\n' +
      '<video src="https://e.com/v.mp4" poster="https://e.com/p.png"></video>\n\n' +
      '<audio><source src="//e.com/a.mp3"></audio>\n\n' +
      '<div style="background:url(https://e.com/bg.png); color: red">x</div>\n\n' +
      '<img src="data:image/png;base64,iVBORw0KGgo=" alt="inline">';
    const blocked = dom(text, ctx({ loadRemoteImages: false }));
    expect(blocked.querySelector('img[src^="https"]')).toBeNull();
    expect(blocked.querySelector('.remote-image-placeholder')?.getAttribute('data-src')).toBe('https://tracker.example/p.gif');
    expect(blocked.querySelector('video')?.hasAttribute('src')).toBe(false);
    expect(blocked.querySelector('video')?.hasAttribute('poster')).toBe(false);
    expect(blocked.querySelector('source')?.hasAttribute('src')).toBe(false);
    expect(blocked.querySelector('div[style]')?.getAttribute('style')).not.toContain('url(');
    expect(blocked.querySelector('img[alt="inline"]')).not.toBeNull();
    const allowed = dom(text, ctx({ loadRemoteImages: true }));
    expect(allowed.querySelector('img')?.getAttribute('src')).toBe('https://tracker.example/p.gif');
  });

  it('renders the tasks of a transcluded note disabled (FE-9, ux)', () => {
    const boxes = [...dom('- [ ] embedded task', ctx({ depth: 1 })).querySelectorAll('input.task-list-item-checkbox')] as HTMLInputElement[];
    expect(boxes).toHaveLength(1);
    expect(boxes[0].disabled).toBe(true);
    expect((dom('- [ ] own task').querySelector('input.task-list-item-checkbox') as HTMLInputElement).disabled).toBe(false);
  });

  it('removes inputs that are not task checkboxes', () => {
    const el = dom('<input type="text" value="x">\n\n- [ ] task');
    const inputs = [...el.querySelectorAll('input')];
    expect(inputs).toHaveLength(1);
    expect(inputs[0].classList.contains('task-list-item-checkbox')).toBe(true);
  });
});

describe('tasks', () => {
  it('stamps checkboxes with line, hash and label', () => {
    const text = '---\na: 1\n---\n- [ ] first\n- [x] second';
    const boxes = [...dom(text).querySelectorAll('input.task-list-item-checkbox')] as HTMLInputElement[];
    expect(boxes.map((b) => b.getAttribute('data-line'))).toEqual(['3', '4']);
    expect(boxes[0].getAttribute('data-hash')).toBe(lineHash('- [ ] first'));
    expect(boxes[0].getAttribute('aria-label')).toBe('first');
    expect(boxes[1].checked).toBe(true);
  });

  it('toggleTaskAtLine flips the marker, including in blockquotes', () => {
    const text = 'x\n- [ ] a\n> - [x] quoted\n1. [ ] numbered';
    const apply = (line: number) => {
      const src = text.split('\n')[line];
      const change = toggleTaskAtLine(text, line, lineHash(src))!;
      return text.slice(0, change.from) + change.insert + text.slice(change.to);
    };
    expect(apply(1)).toBe('x\n- [x] a\n> - [x] quoted\n1. [ ] numbered');
    expect(apply(2)).toBe('x\n- [ ] a\n> - [ ] quoted\n1. [ ] numbered');
    expect(apply(3)).toBe('x\n- [ ] a\n> - [x] quoted\n1. [x] numbered');
  });

  it('ignores a toggle whose line hash is stale', () => {
    expect(toggleTaskAtLine('- [ ] moved', 0, lineHash('- [ ] original'))).toBeNull();
    expect(toggleTaskAtLine('no task', 0, lineHash('no task'))).toBeNull();
  });

  it('detects checkbox-only changes', () => {
    expect(onlyCheckboxesChanged('- [ ] a\n- [x] b', '- [x] a\n- [ ] b')).toBe(true);
    expect(onlyCheckboxesChanged('- [ ] a', '- [ ] b')).toBe(false);
    expect(onlyCheckboxesChanged('a x b', 'a   b')).toBe(false);
  });
});

describe('patch', () => {
  it('keeps an image node when an unrelated paragraph changes', () => {
    const container = document.createElement('div');
    patchChildren(container, renderNote('Intro\n\n![[pic.png]]\n\nOutro', ctx()).fragment);
    const img = container.querySelector('img')!;
    const stats = patchChildren(container, renderNote('Intro changed\n\n![[pic.png]]\n\nOutro', ctx()).fragment);
    expect(container.querySelector('img')).toBe(img);
    expect(stats).toEqual({ kept: 2, inserted: 1, removed: 1 });
    expect(container.firstElementChild?.textContent).toBe('Intro changed');
  });

  it('keeps a block whose only change is a task state, and syncs the checkbox (an opened callout stays open)', () => {
    const container = document.createElement('div');
    patchChildren(container, renderNote('> [!todo]- Tasks\n> - [ ] one\n> - [ ] two', ctx()).fragment);
    const callout = container.firstElementChild as HTMLDetailsElement;
    callout.open = true;
    const stats = patchChildren(container, renderNote('> [!todo]- Tasks\n> - [x] one\n> - [ ] two', ctx()).fragment);
    expect(stats).toEqual({ kept: 1, inserted: 0, removed: 0 });
    expect(container.firstElementChild).toBe(callout);
    expect(callout.open).toBe(true);
    const boxes = callout.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox');
    expect([...boxes].map((b) => b.checked)).toEqual([true, false]);
    expect(boxes[0].getAttribute('data-hash')).toBe(lineHash('> - [x] one'));
  });

  it('never ignores attribute-like text when keying blocks', () => {
    const container = document.createElement('div');
    patchChildren(container, renderNote('a checked="x" data-line="3" b', ctx()).fragment);
    patchChildren(container, renderNote('a b', ctx()).fragment);
    expect(container.textContent).toBe('a b');
  });

  it('updates data-line on kept blocks when lines shift', () => {
    const container = document.createElement('div');
    patchChildren(container, renderNote('A\n\nB', ctx()).fragment);
    const b = container.lastElementChild!;
    patchChildren(container, renderNote('New\n\nA\n\nB', ctx()).fragment);
    expect(container.lastElementChild).toBe(b);
    expect(b.getAttribute('data-line')).toBe('4');
  });
});

describe('extractSection', () => {
  it('returns a heading section up to the next heading of the same level', () => {
    const text = '# A\nintro\n## Risks\n- one\n### Detail\nx\n## Next\ny';
    expect(extractSection(text, 'Risks')).toBe('## Risks\n- one\n### Detail\nx');
    expect(extractSection(text, 'A#risks')).toBe('## Risks\n- one\n### Detail\nx');
    expect(extractSection(text, 'Missing')).toBeNull();
  });
});

describe('rich Markdown around drawings and task lists (items 3, 4 and 5)', () => {
  it('keeps the embeds of a drawing and a task list inside a callout, for their views to hydrate', () => {
    registerBuiltins();
    const docs = new Map(
      ['Sketches/Plan.excalidraw', 'Sketches/Map.excalidraw.md', 'Tasks/Home.tasks'].map((p) => {
        const e = entry(p);
        return [p, { ...e, kind: p.endsWith('.md') ? ('note' as const) : ('text' as const) }];
      }),
    );
    const docIndex = buildLinkIndex(docs.keys());
    const el = dom('> [!todo] This week\n> ![[Home.tasks]]\n> ![[Plan.excalidraw|300]]\n> ![[Map.excalidraw]]\n\n$x^2$', ctx({
      resolve: (t) => {
        const p = resolve(t, 'Welcome.md', docIndex);
        return p ? (docs.get(p) ?? null) : null;
      },
    }));
    const callout = el.querySelector('.callout');
    expect(callout).not.toBeNull();
    const embeds = [...callout!.querySelectorAll('[data-embed-kind]')];
    expect(embeds.map((e) => [e.getAttribute('data-embed-kind'), e.getAttribute('data-embed-path')])).toEqual([
      ['file', 'Tasks/Home.tasks'],
      ['file', 'Sketches/Plan.excalidraw'],
      ['file', 'Sketches/Map.excalidraw.md'],
    ]);
    expect(embeds[1].getAttribute('data-width')).toBe('300');
    expect(el.querySelector('[data-math]')).not.toBeNull();
  });
});
