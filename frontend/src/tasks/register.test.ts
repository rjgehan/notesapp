import { describe, expect, it } from 'vitest';
import { eventHandlerNames, menuPages, registeredOverlays, registeredPages, registeredPanels } from '../extensions';
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
