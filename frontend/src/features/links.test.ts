import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './settings';
import { assembleLink, buildLinkIndex, createPath, encodeMdPath, linkText, resolve, type LinkFormat } from './links';
import type { LinkStyle } from '../api/types';

// API.md §15 fixture vault.
const FIXTURE = [
  'Welcome.md',
  'Plan.md',
  'log.md',
  'v1.2 notes.md',
  'Projects/Plan.md',
  'Projects/Alpha/Spec.md',
  'Projects/Alpha/notes.md',
  'Archive/Spec.md',
  'Archive/2025/Old.md',
  'Attachments/pic.png',
  'Daily/2026-10-16.md',
  'Ideas/Plan B.md',
];
const index = buildLinkIndex(FIXTURE);
const files = DEFAULT_SETTINGS.files;

type ResolveVector = [number, string, string, string | null, string | null, Partial<typeof files>?];
const RESOLVE: ResolveVector[] = [
  [1, 'Daily/2026-10-16.md', 'Plan', 'Plan.md', null],
  [2, 'Projects/Alpha/Spec.md', 'Plan', 'Plan.md', null],
  [3, 'Projects/Alpha/notes.md', 'Spec', 'Projects/Alpha/Spec.md', null],
  [4, 'Daily/2026-10-16.md', 'Spec', 'Archive/Spec.md', null],
  [5, 'Archive/2025/Old.md', 'Spec', 'Archive/Spec.md', null],
  [6, 'Daily/2026-10-16.md', 'Alpha/Spec', 'Projects/Alpha/Spec.md', null],
  [7, 'Projects/Alpha/Spec.md', '../Plan', 'Projects/Plan.md', null],
  [8, 'Projects/Alpha/Spec.md', './notes', 'Projects/Alpha/notes.md', null],
  [9, 'Projects/Alpha/Spec.md', '/Plan', 'Plan.md', null],
  [10, 'Welcome.md', 'LOG', 'log.md', null],
  [11, 'Welcome.md', 'v1.2 notes', 'v1.2 notes.md', null],
  [12, 'Welcome.md', 'pic.png', 'Attachments/pic.png', null],
  [13, 'Welcome.md', 'Plan.md', 'Plan.md', null],
  [14, 'Welcome.md', '', 'Welcome.md', null],
  [15, 'Welcome.md', 'Plan B', 'Ideas/Plan B.md', null],
  [16, 'Welcome.md', 'Missing', null, 'Missing.md'],
  [17, 'Daily/2026-10-16.md', 'Projects/New idea', null, 'Projects/New idea.md'],
  [18, 'Projects/Alpha/Spec.md', './Draft', null, 'Projects/Alpha/Draft.md'],
  [19, 'Welcome.md', 'missing.pdf', null, null],
  [20, 'Welcome.md', '/Spec', null, 'Spec.md'],
  [21, 'Daily/2026-10-16.md', 'Missing', null, 'Daily/Missing.md', { newNoteLocation: 'current' }],
  [22, 'Daily/2026-10-16.md', 'Missing', null, 'Inbox/Missing.md', { newNoteLocation: 'folder', newNoteFolder: 'Inbox' }],
  [23, 'Welcome.md', 'Bad[name', null, null],
  [24, 'Welcome.md', 'v1.3', null, 'v1.3.md'],
  [25, 'Welcome.md', 'Budget.csv', null, null],
];

describe('resolve and createPath (API.md §15.1)', () => {
  it.each(RESOLVE)('#%i %s → %s', (_n, source, target, path, create, settings) => {
    const resolved = resolve(target, source, index);
    expect(resolved).toBe(path);
    if (resolved === null) expect(createPath(target, source, { ...files, ...settings })).toBe(create);
  });

  it('prefers the exact-case path among case-variant duplicates, else the lowest', () => {
    const dup = buildLinkIndex(['a/Note.md', 'a/note.md']);
    expect(resolve('a/note', 'x.md', dup)).toBe('a/note.md');
    expect(resolve('a/NOTE', 'x.md', dup)).toBe('a/Note.md');
  });

  it('prefers the source folder in the suffix step', () => {
    const idx = buildLinkIndex(['A/x/Spec.md', 'B/Spec.md']);
    expect(resolve('Spec', 'A/x/Other.md', idx)).toBe('A/x/Spec.md');
  });

  it('never escapes the vault root on relative lookups', () => {
    expect(resolve('../../x', 'a.md', index)).toBeNull();
    expect(createPath('../../x', 'a.md', files)).toBeNull();
  });

  it('creates notes for names whose final dot part is not a known file kind (as the server does)', () => {
    expect(createPath('v2.0 release notes', 'Welcome.md', files)).toBe('v2.0 release notes.md');
    expect(createPath('v1.3', 'Welcome.md', files)).toBe('v1.3.md');
    expect(createPath('Report.final', 'Welcome.md', files)).toBe('Report.final.md');
    expect(createPath('Budget.CSV', 'Welcome.md', files)).toBeNull();
    expect(createPath('clip.webm', 'Welcome.md', files)).toBeNull();
  });
});

type TextVector = [number, string, string, LinkFormat, LinkStyle, string];
const LINK_TEXT: TextVector[] = [
  [1, 'Projects/Alpha/notes.md', 'Welcome.md', 'shortest', 'wiki', 'notes'],
  [2, 'Projects/Plan.md', 'Welcome.md', 'shortest', 'wiki', 'Projects/Plan'],
  [3, 'Plan.md', 'Daily/2026-10-16.md', 'shortest', 'wiki', 'Plan'],
  [4, 'Archive/Spec.md', 'Welcome.md', 'shortest', 'wiki', 'Archive/Spec'],
  [5, 'Projects/Alpha/Spec.md', 'Projects/Alpha/notes.md', 'relative', 'wiki', './Spec'],
  [6, 'Plan.md', 'Projects/Alpha/Spec.md', 'relative', 'wiki', '../../Plan'],
  [7, 'Attachments/pic.png', 'Welcome.md', 'shortest', 'wiki', 'pic.png'],
  [8, 'Ideas/Plan B.md', 'Welcome.md', 'shortest', 'markdown', 'Plan%20B.md'],
  [9, 'Projects/Plan.md', 'Welcome.md', 'absolute', 'markdown', 'Projects/Plan.md'],
  [10, 'v1.2 notes.md', 'Welcome.md', 'shortest', 'wiki', 'v1.2 notes'],
  [11, 'Daily/2026-10-16.md', 'Welcome.md', 'shortest', 'wiki', '2026-10-16'],
  [12, 'Ideas/Plan B.md', 'Projects/Plan.md', 'relative', 'markdown', '../Ideas/Plan%20B.md'],
];

describe('linkText (API.md §15.3)', () => {
  it.each(LINK_TEXT)('#%i %s from %s', (_n, target, source, format, style, expected) => {
    expect(linkText(target, source, format, style, index)).toBe(expected);
  });

  it('round-trips for every file, source and format', () => {
    for (const target of FIXTURE) {
      for (const source of FIXTURE) {
        for (const format of ['shortest', 'relative', 'absolute'] as const) {
          const text = linkText(target, source, format, 'wiki', index);
          expect(resolve(text, source, index)).toBe(target);
        }
      }
    }
  });
});

describe('encodeMdPath', () => {
  it('encodes exactly the listed characters', () => {
    expect(encodeMdPath('Notes (draft)/a b%.md')).toBe('Notes%20%28draft%29/a%20b%25.md');
    expect(encodeMdPath('Café.md')).toBe('Café.md');
    expect(encodeMdPath('a[b]#c^d|e<f>g\u0001')).toBe('a%5Bb%5D%23c%5Ed%7Ce%3Cf%3Eg%01');
  });
});

describe('assembleLink', () => {
  it('builds every form of API.md §15.3', () => {
    expect(assembleLink('Plan', 'wiki', 'Plan.md')).toBe('[[Plan]]');
    expect(assembleLink('Plan', 'wiki', 'Plan.md', { display: 'the plan' })).toBe('[[Plan|the plan]]');
    expect(assembleLink('pic.png', 'wiki', 'pic.png', { embed: true })).toBe('![[pic.png]]');
    expect(assembleLink('Plan%20B.md', 'markdown', 'Ideas/Plan B.md')).toBe('[Plan B](Plan%20B.md)');
    expect(assembleLink('pic.png', 'markdown', 'pic.png', { embed: true })).toBe('![](pic.png)');
  });
});
