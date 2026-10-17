import { describe, expect, it } from 'vitest';
import {
  basenameOf,
  decodeRoutePath,
  displayName,
  encodeRoutePath,
  extensionOf,
  folderOf,
  joinPath,
  newNameError,
  normalizeDots,
  pathFromLocation,
  relativePath,
} from './paths';

describe('paths', () => {
  it('joinPath with the root folder', () => {
    expect(joinPath('', 'x.md')).toBe('x.md');
    expect(joinPath('a', 'x.md')).toBe('a/x.md');
  });

  it('folderOf, basename and extension', () => {
    expect(folderOf('a/b/c.md')).toBe('a/b');
    expect(folderOf('c.md')).toBe('');
    expect(basenameOf('Budget.sheet')).toBe('Budget');
    expect(basenameOf('archive.tar.gz')).toBe('archive.tar');
    expect(basenameOf('.env')).toBe('.env');
    expect(extensionOf('a/Photo.PNG')).toBe('png');
    expect(extensionOf('README')).toBe('');
    expect(displayName('a/Plan.md')).toBe('Plan');
    expect(displayName('a/pic.png')).toBe('pic.png');
  });

  it.each([
    'Daily Notes/2026-10-16.md',
    '100%/done.md',
    'Q&A/#1?.md',
    'Café/naïve 日本.md',
    'a+b/c d.md',
  ])('route encoding round-trips %s', (path) => {
    const encoded = encodeRoutePath(path);
    expect(encoded).not.toMatch(/[ #?%](?![0-9A-F]{2})/);
    expect(decodeRoutePath(encoded)).toBe(path);
    expect(pathFromLocation('/n/' + encoded)).toBe(path);
  });

  it('encodes route segments individually', () => {
    expect(encodeRoutePath('Daily Notes/2026-10-16.md')).toBe('Daily%20Notes/2026-10-16.md');
    expect(pathFromLocation('/search')).toBeNull();
  });

  it('normalizes dot segments', () => {
    expect(normalizeDots('a/b/../c')).toBe('a/c');
    expect(normalizeDots('./a')).toBe('a');
    expect(normalizeDots('../a')).toBeNull();
  });

  it('computes relative paths', () => {
    expect(relativePath('Projects/Alpha', 'Projects/Alpha/Spec')).toBe('Spec');
    expect(relativePath('Projects/Alpha', 'Plan')).toBe('../../Plan');
    expect(relativePath('', 'a/b')).toBe('a/b');
  });

  it.each(['a:b', 'a#b', 'a^b', 'a[b', 'a|b', 'x%%y', ' lead', 'trail.', 'con', 'LPT1.txt', 'x.tmp', 'a~', 'Thumbs.db', '.hidden'])(
    'rejects the new name %s',
    (name) => {
      expect(newNameError(name)).not.toBeNull();
    },
  );

  it('accepts ordinary names', () => {
    expect(newNameError('Plan B.md')).toBeNull();
    expect(newNameError('Café 2026-10-16.md')).toBeNull();
    expect(newNameError('a'.repeat(240))).toBeNull();
    expect(newNameError('a'.repeat(241))).not.toBeNull();
  });
});
