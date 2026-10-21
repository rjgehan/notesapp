import { describe, expect, it } from 'vitest';
import { ApiError } from '../client';
import { sanitizeAttachmentName } from './names';
import { blobId } from './sha1';
import { MockVault } from './vault';

const enc = new TextEncoder();

describe('blobId (API.md §1.6)', () => {
  it('matches git', () => {
    expect(blobId(new Uint8Array())).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    expect(blobId(enc.encode('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });
});

describe('attachment name sanitizer (DESIGN §4.4)', () => {
  it.each([
    ['a/b.png', 'b.png'],
    ['../x.png', 'x.png'],
    ['.env', 'env'],
    ['con.png', '_con.png'],
    ['x.tmp', 'x.tmp.file'],
    ['notes .', 'notes'],
    ['a:b?.png', 'a-b-.png'],
    ['.png', 'attachment.png'],
  ])('%s → %s', (input, expected) => {
    expect(sanitizeAttachmentName(input)).toBe(expected);
  });

  it('truncates long names to 240 bytes on a code point boundary', () => {
    const name = sanitizeAttachmentName('é'.repeat(150) + '.png');
    expect(enc.encode(name).length).toBeLessThanOrEqual(240);
    expect(name.endsWith('.png')).toBe(true);
    expect(name).not.toContain('�');
  });
});

function problemCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    if (e instanceof ApiError) return e.problem.code;
    throw e;
  }
  return undefined;
}

describe('MockVault version protocol (API.md §4)', () => {
  it('saves, rejects stale bases and accepts idempotent retries', () => {
    const v = new MockVault(false);
    const created = v.createFile({ path: 'a.md', content: 'one' }, 'c1');
    const base = created.file.version!;
    const saved = v.saveFile('a.md', { content: 'two', baseVersion: base }, 'c1');
    expect(saved.file.version).not.toBe(base);
    // Retry of the same content with the old base succeeds.
    expect(v.saveFile('a.md', { content: 'two', baseVersion: base }, 'c1').file.version).toBe(saved.file.version);
    expect(problemCode(() => v.saveFile('a.md', { content: 'three', baseVersion: base }, 'c1'))).toBe('version-conflict');
  });

  it('reports movedTo for a moved file', () => {
    const v = new MockVault(false);
    const { file } = v.createFile({ path: 'a.md', content: 'x' }, 'c1');
    v.move({ from: 'a.md', to: 'b.md' }, 'c2');
    try {
      v.saveFile('a.md', { content: 'y', baseVersion: file.version }, 'c1');
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).problem).toMatchObject({ code: 'version-conflict', currentVersion: null, movedTo: 'b.md' });
    }
  });

  it('renames on conflict and rejects case collisions', () => {
    const v = new MockVault(false);
    v.createFile({ path: 'Untitled.md' }, 'c1');
    expect(v.createFile({ path: 'Untitled.md', onConflict: 'rename' }, 'c1').file.path).toBe('Untitled 1.md');
    expect(problemCode(() => v.createFile({ path: 'untitled.md' }, 'c1'))).toBe('case-collision');
    expect(problemCode(() => v.createFile({ path: 'bad#name.md' }, 'c1'))).toBe('invalid-name');
  });

  it('rewrites links when a note moves', () => {
    const v = new MockVault(false);
    v.createFile({ path: 'Plan.md', content: '# Plan' }, 'c1');
    v.createFile({ path: 'Other.md', content: 'See [[Plan#Goals|the plan]] and [x](Plan.md).' }, 'c1');
    const result = v.move({ from: 'Plan.md', to: 'Projects/Roadmap.md' }, 'c1');
    expect(result.linkUpdates).toEqual([{ path: 'Other.md', links: 2, version: expect.any(String) }]);
    expect(v.readFile('Other.md').content).toBe('See [[Roadmap#Goals|the plan]] and [x](Roadmap.md).');
  });
});

describe('MockVault bookmarks (API.md §21)', () => {
  it('follows the version protocol and re-keys bookmarks after a move and a restore elsewhere', () => {
    const v = new MockVault(false);
    v.createFile({ path: 'Plan.md', content: '# Plan' }, 'c1');
    const empty = v.getBookmarks();
    const saved = v.putBookmarks({ items: [{ type: 'file', ctime: 1, path: 'Plan.md', subpath: '#Plan' }], baseVersion: empty.version }, 'c1');
    expect(saved.version).not.toBe(empty.version);
    expect(problemCode(() => v.putBookmarks({ items: [], baseVersion: empty.version }, 'c2'))).toBe('version-conflict');
    v.move({ from: 'Plan.md', to: 'Projects/Plan.md' }, 'c1');
    expect(v.getBookmarks().items[0]).toMatchObject({ path: 'Projects/Plan.md', subpath: '#Plan' });
    const entry = v.deleteFile('Projects/Plan.md', 'c1');
    expect(v.getBookmarks().items[0].path).toBe('Projects/Plan.md');
    v.restoreTrash(entry.id, { to: 'Archive/Plan.md' }, 'c1');
    expect(v.getBookmarks().items[0].path).toBe('Archive/Plan.md');
  });
});
