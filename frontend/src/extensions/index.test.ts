import { FileText } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { getCommand, runCommand } from '../features/commands';
import { registerBuiltins } from './builtins';
import { pageRoute, registerPage, registeredPages, registerView } from './index';

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
});
