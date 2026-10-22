import { describe, expect, it } from 'vitest';
import { cleanFolder, composeNote, frontmatter, localDate, noteBasename, notePath, publishedDate, replaceImage, yamlString } from '../src/core/note';
import type { Clip } from '../src/core/types';

const clip = (over: Partial<Clip> = {}): Clip => ({
  title: 'How to: write "good" notes',
  url: 'https://example.com/a?b=1',
  author: 'Ada Lovelace',
  siteName: 'Example',
  published: '2026-09-30T08:00:00Z',
  description: 'A short\nsummary.',
  markdown: 'Body text.\n',
  images: [],
  selection: false,
  ...over,
});

const LS = String.fromCharCode(0x2028);

describe('noteBasename', () => {
  it.each([
    ['How to: write "good" notes', 'How to write good notes'],
    ['A/B testing | results', 'A-B testing - results'],
    ['#1 [draft] ^x <y>?*', '1 draft x y'],
    ['50%% off', '50% off'],
    ['  ..hidden.  ', 'hidden'],
    ['con', '_con'],
    ['backup~', 'backup~ clip'],
    ['report.tmp', 'report.tmp clip'],
    ['', 'Clipping'],
    [':::', 'Clipping'],
    ['line\nbreak\ttab', 'line break tab'],
    ['Cafe' + String.fromCharCode(0x301), 'Caf' + String.fromCharCode(0xe9)],
  ])('%j becomes %j', (input, expected) => {
    expect(noteBasename(input)).toBe(expected);
  });

  it('fits 200 UTF-8 bytes on a code-point boundary', () => {
    const e = String.fromCharCode(0xe9);
    const name = noteBasename(e.repeat(150));
    expect(new TextEncoder().encode(name).length).toBeLessThanOrEqual(200);
    expect(name).toBe(e.repeat(100));
  });
});

describe('folders and paths', () => {
  it('cleans each segment and drops empty and relative ones', () => {
    expect(cleanFolder('/Clippings//Web/../x:y/')).toBe('Clippings/Web/xy');
    expect(cleanFolder('')).toBe('');
  });

  it('joins the folder and the name', () => {
    expect(notePath('Clippings', 'A: B')).toBe('Clippings/A B.md');
    expect(notePath('', 'A')).toBe('A.md');
  });
});

describe('frontmatter', () => {
  it('quotes strings as YAML double-quoted scalars', () => {
    expect(yamlString('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
    expect(yamlString('x' + LS + 'y')).toBe('"x\\u2028y"');
  });

  it('reduces the published date to a day', () => {
    expect(publishedDate('2026-09-30T23:00:00-05:00')).toBe('2026-09-30');
    expect(publishedDate('Tue, 01 Sep 2026 10:00:00 GMT')).toBe('2026-09-01');
    expect(publishedDate('last week')).toBeNull();
    expect(publishedDate(null)).toBeNull();
  });

  it('writes the properties Obsidian Web Clipper writes', () => {
    expect(frontmatter(clip(), '2026-10-21')).toBe(
      [
        '---',
        'title: "How to: write \\"good\\" notes"',
        'source: "https://example.com/a?b=1"',
        'author: "Ada Lovelace"',
        'site: "Example"',
        'published: 2026-09-30',
        'created: 2026-10-21',
        'description: "A short summary."',
        'tags:',
        '  - clippings',
        '---',
        '',
      ].join('\n'),
    );
  });

  it('leaves out what the page does not say', () => {
    const fm = frontmatter(clip({ title: '', author: null, siteName: ' ', published: null, description: null }), '2026-10-21');
    expect(fm).toBe('---\ntitle: "Clipping"\nsource: "https://example.com/a?b=1"\ncreated: 2026-10-21\ntags:\n  - clippings\n---\n');
  });
});

describe('composeNote', () => {
  it('builds the POST /api/files body', () => {
    const req = composeNote(clip({ markdown: '\n\nHello\r\nworld\n\n\n' }), { created: '2026-10-21' });
    expect(req.path).toBe('Clippings/How to write good notes.md');
    expect(req.onConflict).toBe('rename');
    expect(req.content.endsWith('---\n\nHello\nworld\n')).toBe(true);
  });

  it('takes a folder and a name', () => {
    expect(composeNote(clip(), { folder: 'Web/Read later', basename: 'Mine', created: '2026-10-21' }).path).toBe('Web/Read later/Mine.md');
  });

  it('formats the local date', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('replaceImage', () => {
  it('replaces every image of the URL, with or without a title', () => {
    const md = 'a ![x](https://e.com/i.png) b ![y](https://e.com/i.png "T") c ![z](https://e.com/i.png?2) [link](https://e.com/i.png)';
    expect(replaceImage(md, 'https://e.com/i.png', '![[i.png]]')).toBe('a ![[i.png]] b ![[i.png]] c ![z](https://e.com/i.png?2) [link](https://e.com/i.png)');
  });

  it('treats the URL literally', () => {
    expect(replaceImage('![a](https://e.com/a+b.png)', 'https://e.com/a+b.png', 'X')).toBe('X');
    expect(replaceImage('![a](https://e.com/aab.png)', 'https://e.com/a+b.png', 'X')).toBe('![a](https://e.com/aab.png)');
  });
});
