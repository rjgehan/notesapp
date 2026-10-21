import { FileText } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { getCommand, runCommand } from '../features/commands';
import { registerBuiltins } from './builtins';
import { useUi } from '../state/ui';
import { menuPages, pageRoute, registerOverlay, registerPage, registeredOverlays, registeredPages, registerView, viewFor } from './index';

describe('registerView create (DESIGN §6.8)', () => {
  it('adds "Create new <label>" to the palette for a view registered later', () => {
    registerBuiltins();
    expect(getCommand('file.new.markdown')).toBeUndefined();
    expect(getCommand('file.new.probe')).toBeUndefined();
    registerView({
      id: 'probe',
      match: (e) => (e.path.endsWith('.probe') ? 6 : 0),
      icon: FileText,
      textual: true,
      modes: ['edit'],
      load: () => Promise.resolve({ default: () => null }),
      create: { label: 'probe', extension: 'probe', initialContent: () => '{}' },
    });
    expect(getCommand('file.new.probe')?.name).toBe('Create new probe');
  });

  it('registers the spreadsheet view with "Create new spreadsheet" (ROADMAP item 6)', () => {
    registerBuiltins();
    expect(getCommand('file.new.sheet')?.name).toBe('Create new spreadsheet');
  });
});

describe('registerPage (DESIGN §6.8)', () => {
  it('adds a route under /x/ and a palette command that opens it', () => {
    const page = { route: 'tasks/today', title: 'Today’s tasks', icon: FileText, load: () => Promise.resolve({ default: () => null }) };
    registerPage(page);
    expect(registeredPages()).toContain(page);
    expect(pageRoute(page)).toBe('/x/tasks/today');
    expect(getCommand('page.tasks/today')?.name).toBe('Open Today’s tasks');
    runCommand('page.tasks/today', { activePath: null });
    expect(location.pathname).toBe('/x/tasks/today');
  });

  it('closes the phone drawer when its entry opens the page', () => {
    const page = { route: 'status-test', title: 'Status test', icon: FileText, load: () => Promise.resolve({ default: () => null }) };
    registerPage(page);
    useUi.getState().setDrawerOpen(true);
    runCommand('page.status-test', { activePath: null });
    expect(useUi.getState().drawerOpen).toBe(false);
    expect(location.pathname).toBe('/x/status-test');
  });
});

describe('hidden pages and overlays (DESIGN §6.8)', () => {
  it('gives a hidden page a route only, without a menu entry or command', () => {
    const page = { route: 'demo/item/:id', title: 'Demo item', icon: FileText, hidden: true, load: () => Promise.resolve({ default: () => null }) };
    registerPage(page);
    expect(registeredPages()).toContain(page);
    expect(menuPages()).not.toContain(page);
    expect(getCommand('page.demo/item/:id')).toBeUndefined();
  });

  it('registers an overlay host once per id', () => {
    const first = { id: 'demo', component: () => null };
    const second = { id: 'demo', component: () => null };
    registerOverlay(first);
    registerOverlay(second);
    expect(registeredOverlays().filter((o) => o.id === 'demo')).toEqual([second]);
  });
});

describe('drawings, tasks and the status page together (DESIGN §6.8)', () => {
  const entry = (path: string, kind: 'note' | 'text') => {
    const name = path.slice(path.lastIndexOf('/') + 1);
    return { path, name, basename: name.replace(/\.[^.]+$/, ''), extension: name.slice(name.lastIndexOf('.') + 1), kind, size: 1, mtime: '2026-10-21T10:00:00.000Z', version: 'v', aliases: [] };
  };

  it('gives each file its own view, and every page and command its place', () => {
    registerBuiltins();
    expect(viewFor(entry('Tasks/Home.tasks', 'text')).id).toBe('tasks');
    expect(viewFor(entry('Sketches/Plan.excalidraw', 'text')).id).toBe('excalidraw');
    expect(viewFor(entry('Sketches/Map.excalidraw.md', 'note')).id).toBe('excalidraw-md');
    expect(viewFor(entry('Notes/Plan.md', 'note')).id).toBe('markdown');
    expect(getCommand('file.new.excalidraw')?.name).toBe('Create new drawing');
    expect(getCommand('tasks.quickAdd')?.globalHotkey).toBe(true);
    const menu = menuPages().map((p) => p.route);
    expect(menu).toEqual(expect.arrayContaining(['status', 'tasks/today', 'tasks']));
    expect(menu).not.toContain('tasks/list/:id');
    expect(registeredPages().map((p) => p.route)).toContain('tasks/list/:id');
    // A task page opened from the phone drawer closes it, as the status page does.
    useUi.getState().setDrawerOpen(true);
    runCommand('page.tasks/today', { activePath: null });
    expect(useUi.getState().drawerOpen).toBe(false);
    expect(location.pathname).toBe('/x/tasks/today');
  });
});
