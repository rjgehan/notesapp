import { FileText } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { getCommand, runCommand } from '../features/commands';
import { registerBuiltins } from './builtins';
import { menuPages, pageRoute, registerOverlay, registerPage, registeredOverlays, registeredPages, registerView } from './index';

describe('registerView create (DESIGN §6.8)', () => {
  it('adds "Create new <label>" to the palette for a view registered later', () => {
    registerBuiltins();
    expect(getCommand('file.new.markdown')).toBeUndefined();
    registerView({
      id: 'sheet',
      match: (e) => (e.path.endsWith('.sheet') ? 6 : 0),
      icon: FileText,
      textual: true,
      modes: ['edit'],
      load: () => Promise.resolve({ default: () => null }),
      create: { label: 'spreadsheet', extension: 'sheet', initialContent: () => '{}' },
    });
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
