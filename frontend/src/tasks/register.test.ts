import { describe, expect, it } from 'vitest';
import { eventHandlerNames, menuPages, registeredOverlays, registeredPages, registeredPanels, viewFor } from '../extensions';
import { getCommand, runCommand } from '../features/commands';
import { TASK_EVENT_NAMES } from '../api/types';
import { QUICK_ADD_HOTKEY, registerTasks } from './register';
import { localToday } from './dates';
import { useTaskUi } from './ui/state';

describe('tasks through the extension points (DESIGN §6.8, §6.22)', () => {
  it('registers the pages, the panel, quick add, the overlay host and the event handlers', () => {
    registerTasks();
    const routes = registeredPages().map((p) => p.route);
    expect(routes).toEqual(expect.arrayContaining(['tasks/today', 'tasks', 'tasks/list/:id']));
    expect(menuPages().map((p) => p.route)).not.toContain('tasks/list/:id');
    expect(getCommand('page.tasks')?.name).toBe('Open Task lists');
    expect(registeredPanels('right').map((p) => p.id)).toContain('tasks');
    expect(registeredOverlays().map((o) => o.id)).toContain('tasks');
    expect(eventHandlerNames()).toEqual(expect.arrayContaining([...TASK_EVENT_NAMES]));
    const quickAdd = getCommand('tasks.quickAdd');
    expect(quickAdd).toMatchObject({ hotkey: QUICK_ADD_HOTKEY, globalHotkey: true });
  });

  it('registers the phase 4b views: Upcoming, Completed, Filter, the tasks file view and convert', () => {
    registerTasks();
    expect(registeredPages().map((p) => p.route)).toEqual(expect.arrayContaining(['tasks/upcoming', 'tasks/completed', 'tasks/filter']));
    // The ribbon gets Today, Upcoming and the lists; the others are tabs on the task pages and palette commands.
    expect(menuPages().map((p) => p.route)).toEqual(expect.arrayContaining(['tasks/today', 'tasks/upcoming', 'tasks']));
    expect(menuPages().map((p) => p.route)).not.toContain('tasks/completed');
    expect(getCommand('page.tasks/completed')?.name).toBe('Open Completed tasks');
    expect(getCommand('page.tasks/filter')?.name).toBe('Open Filter tasks');
    const view = viewFor({ path: 'Tasks/Home.tasks', name: 'Home.tasks', basename: 'Home', extension: 'tasks', kind: 'text', size: 1, mtime: '2026-10-17T10:00:00Z', version: 'v1', aliases: [] });
    expect(view.id).toBe('tasks');
    expect(view.loadEmbed).toBeTypeOf('function');
    // Convert is offered only with the cursor on an open checkbox of a note.
    const convert = getCommand('tasks.convertCheckbox');
    expect(convert?.name).toBe('Convert checkbox to task');
    expect(convert?.when?.({ activePath: null })).toBe(false);
  });

  it('opens quick add in the context of the page shown', () => {
    registerTasks();
    window.history.pushState(null, '', '/x/tasks/list/L%201');
    runCommand('tasks.quickAdd', { activePath: null });
    expect(useTaskUi.getState().quickAdd).toEqual({ listId: 'L 1' });
    window.history.pushState(null, '', '/x/tasks/today');
    runCommand('tasks.quickAdd', { activePath: null });
    expect(useTaskUi.getState().quickAdd).toEqual({ due: localToday() });
    window.history.pushState(null, '', '/n/Welcome.md');
    runCommand('tasks.quickAdd', { activePath: 'Welcome.md' });
    expect(useTaskUi.getState().quickAdd).toEqual({});
  });
});
