import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from './settings';
import { failedReason, nameWithExtension, newNoteFolder, updatedFilesText, validateNewName } from './fileOps';

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

describe('failedReason (MoveResult.failed)', () => {
  it('says why, and points a task list the server would not rewrite to its tasks', () => {
    expect(failedReason({ path: 'Notes/Plan.md', reason: 'not-rewritable' })).toBe('a property link that cannot be rewritten');
    expect(failedReason({ path: 'Tasks/Home.tasks', reason: 'not-rewritable' })).toBe('a task list that cannot be changed here; edit the links in its tasks');
    expect(failedReason({ path: 'Tasks/Home.tasks', reason: 'io-error' })).toBe('storage error');
    expect(failedReason({ path: 'Sketches/Plan.excalidraw', reason: 'not-rewritable' })).toBe('a link in the drawing that cannot be rewritten; edit it in the drawing');
    expect(failedReason({ path: 'Sketches/Old.Excalidraw.md', reason: 'not-rewritable' })).toBe('a link in the drawing that cannot be rewritten; edit it in the drawing');
  });
});

describe('updatedFilesText', () => {
  it('counts notes, or files once a task list is among them', () => {
    expect(updatedFilesText([{ path: 'A.md' }])).toBe('1 note');
    expect(updatedFilesText([{ path: 'A.md' }, { path: 'B.md' }])).toBe('2 notes');
    expect(updatedFilesText([{ path: 'Tasks/Home.tasks' }])).toBe('1 file');
    expect(updatedFilesText([{ path: 'A.md' }, { path: 'Tasks/Home.tasks' }])).toBe('2 files');
  });
});
