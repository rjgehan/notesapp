import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './settings';
import { nameWithExtension, newNoteFolder, validateNewName } from './fileOps';

describe('nameWithExtension', () => {
  it('keeps the extension when only the basename is edited', () => {
    expect(nameWithExtension('Projects/Plan.md', 'Roadmap', 'file')).toBe('Roadmap.md');
    expect(nameWithExtension('Attachments/Photo.JPG', 'Beach', 'file')).toBe('Beach.JPG');
    expect(nameWithExtension('archive.tar.gz', 'backup.tar', 'file')).toBe('backup.tar.gz');
    expect(nameWithExtension('README', 'Readme', 'file')).toBe('Readme');
    expect(nameWithExtension('Projects', 'Work', 'folder')).toBe('Work');
  });
});

describe('validateNewName (new-name rules, DESIGN §4.4)', () => {
  it('rejects a slash with a pointer to Move to…', () => {
    expect(validateNewName('a/b.md')).toBe('Use Move to… to change folders');
  });

  it.each(['Plan #2.md', 'a:b.md', 'con.md', 'name.', ' lead.md', 'x.tmp', 'a%%b.md', ''])('rejects %j', (name) => {
    expect(validateNewName(name)).not.toBeNull();
  });

  it.each(['Plan 2.md', 'Café notes.md', 'v1.2 notes.md'])('accepts %j', (name) => {
    expect(validateNewName(name)).toBeNull();
  });
});

describe('newNoteFolder (API.md §5 newNoteLocation)', () => {
  const s = (newNoteLocation: 'root' | 'current' | 'folder', newNoteFolder = 'Inbox') => ({
    ...DEFAULT_SETTINGS,
    files: { ...DEFAULT_SETTINGS.files, newNoteLocation, newNoteFolder },
  });

  it('follows the setting', () => {
    expect(newNoteFolder('Daily/2026-10-16.md', s('root'))).toBe('');
    expect(newNoteFolder('Daily/2026-10-16.md', s('current'))).toBe('Daily');
    expect(newNoteFolder(null, s('current'))).toBe('');
    expect(newNoteFolder('Daily/2026-10-16.md', s('folder'))).toBe('Inbox');
  });
});
