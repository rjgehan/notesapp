// Scripts in notes (ROADMAP items 40 and 17, DESIGN §6.42) through the extension points of DESIGN
// §6.8: event handlers that make the results of the scripts that read a changed note stale (the
// showing ones run again, debounced: editor/livePreview/scripts.ts), and the `/` menu's
// "Script block" and "Dataview query".
import { invalidateScripts } from '../editor/livePreview/scripts';
import { registerSlashItem } from '../editor/slash';
import { insertBlock } from '../editor/slashItems';
import { registerEventHandler } from '../extensions';

/** The paths an event changed, or null when it may have changed any note (a folder, a resync). */
export function changedPaths(name: string, data: unknown): string[] | null {
  const d = (data ?? {}) as { path?: unknown; file?: { path?: unknown }; from?: unknown; to?: unknown; type?: unknown };
  switch (name) {
    case 'file.created':
    case 'file.changed':
      return typeof d.file?.path === 'string' ? [d.file.path] : null;
    case 'file.deleted':
      return typeof d.path === 'string' ? [d.path] : null;
    case 'entry.moved':
      return d.type === 'file' && typeof d.from === 'string' && typeof d.to === 'string' ? [d.from, d.to] : null;
    default:
      return null;
  }
}

const EVENTS = ['file.created', 'file.changed', 'file.deleted', 'entry.moved', 'folder.deleted', 'resync'];

export const SCRIPT_TEMPLATE = '```script\nshow("Today is " + today().format("dddd D MMMM"))\n```';
export const DATAVIEW_TEMPLATE = '```dataview\nTABLE file.mtime AS "Modified"\nSORT file.mtime DESC\nLIMIT 10\n```';

let registered = false;

export function registerScripts(): void {
  if (registered) return;
  registered = true;
  for (const name of EVENTS) {
    registerEventHandler(name, (data) => {
      const paths = changedPaths(name, data);
      // Only notes are read by scripts; another file's change matters only when it is unknown.
      if (paths && paths.every((p) => !p.toLowerCase().endsWith('.md'))) return;
      invalidateScripts(paths);
    });
  }
  registerSlashItem({
    id: 'script',
    label: 'Script block',
    keywords: 'script javascript js code run compute',
    group: 'Block',
    scope: 'block',
    order: 29.5,
    run: (v) => insertBlock(v, SCRIPT_TEMPLATE, '```script\n'.length),
  });
  registerSlashItem({
    id: 'dataview',
    label: 'Dataview query',
    keywords: 'dataview query table list task dql',
    group: 'Block',
    scope: 'block',
    order: 29.6,
    run: (v) => insertBlock(v, DATAVIEW_TEMPLATE, '```dataview\n'.length),
  });
}
