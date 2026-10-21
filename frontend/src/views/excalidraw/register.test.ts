import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../../api/types';
import { registerBuiltins } from '../../extensions/builtins';
import { getCommand } from '../../features/commands';
import { isMarkdownViewPath, viewFor } from '../registry';
import { parseDrawing } from './format';
import { EXCALIDRAW_ASSET_PATH } from './register';

function entry(path: string, kind: FileEntry['kind']): FileEntry {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { path, name, basename: name.replace(/\.[^.]+$/, ''), extension: name.slice(name.lastIndexOf('.') + 1), kind, size: 1, mtime: '2026-10-17T10:00:00.000Z', version: 'v', aliases: [] };
}

describe('drawing views', () => {
  registerBuiltins();

  it('open .excalidraw and .excalidraw.md files; other notes stay Markdown', () => {
    expect(viewFor(entry('Plan.excalidraw', 'text')).id).toBe('excalidraw');
    expect(viewFor(entry('Map.excalidraw.md', 'note')).id).toBe('excalidraw-md');
    expect(viewFor(entry('Map.Excalidraw.MD', 'note')).id).toBe('excalidraw-md');
    expect(viewFor(entry('Notes.md', 'note')).id).toBe('markdown');
    expect(viewFor(entry('data.json', 'text')).id).toBe('text');
  });

  it('are textual, merge semantically, and offer "New drawing"', () => {
    const d = viewFor(entry('Plan.excalidraw', 'text'));
    expect(d.textual).toBe(true);
    expect(d.merge).toBeTypeOf('function');
    expect(viewFor(entry('Map.excalidraw.md', 'note')).merge).toBeTypeOf('function');
    expect(d.create).toMatchObject({ label: 'drawing', extension: 'excalidraw' });
    expect(parseDrawing('excalidraw', d.create!.initialContent())).toMatchObject({ ok: true });
    expect(getCommand('file.new.excalidraw')?.name).toBe('Create new drawing');
    // New drawings are .excalidraw only (DESIGN §6.8.1).
    expect(viewFor(entry('Map.excalidraw.md', 'note')).create).toBeUndefined();
    // ![[drawing]] embeds through the view (a lazy chunk).
    expect(d.loadEmbed).toBeTypeOf('function');
    expect(viewFor(entry('Map.excalidraw.md', 'note')).loadEmbed).toBeTypeOf('function');
  });

  it('point Excalidraw at the self-hosted fonts', () => {
    expect(EXCALIDRAW_ASSET_PATH).toMatch(/^\/assets\/excalidraw-\d+\.\d+\.\d+\/$/);
    expect(window.EXCALIDRAW_ASSET_PATH).toBe(EXCALIDRAW_ASSET_PATH);
  });
});

describe('isMarkdownViewPath', () => {
  registerBuiltins();

  it('is true for notes the Markdown view shows, false for drawings and other files', () => {
    expect(isMarkdownViewPath('Notes/Plan.md')).toBe(true);
    expect(isMarkdownViewPath('Notes/Map.excalidraw.md')).toBe(false);
    expect(isMarkdownViewPath('Notes/Plan.excalidraw')).toBe(false);
    expect(isMarkdownViewPath('data.json')).toBe(false);
  });
});
