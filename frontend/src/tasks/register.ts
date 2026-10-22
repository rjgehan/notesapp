// Structured tasks (ROADMAP item 4) plugged in through the extension points (DESIGN §6.8, §6.22):
// the Today, Upcoming, list index, list, Completed and Filter pages, the `tasks` file view with
// its `![[List.tasks]]` embeds, the "Tasks linking to this note" panel, the quick-add and convert
// commands, the overlay host of the quick-add dialog and the detail sheet, and the live updates of
// the task events. Everything heavy loads lazily with the pages.
import { CalendarCheck, CalendarRange, CircleCheckBig, ListChecks, ListFilter, ListTodo, SquareCheck, SquarePlus } from 'lucide-react';
import { queryClient } from '../api/queryClient';
import { registerCommand, registerEventHandler, registerOverlay, registerPage, registerPanel, registerView } from '../extensions';
import { navigateTo } from '../features/navigation';
import { useUi } from '../state/ui';
import { checkboxAtCursor, convertCheckboxToTask } from './convert';
import { taskStore } from './store';
import { installTaskSync } from './sync';
import { TaskOverlays } from './ui/TaskOverlays';
import { localToday } from './dates';
import { openQuickAdd, type QuickAddContext } from './ui/state';
import { appPathname } from '../state/vault';
import './tasks.css';

let registered = false;

/** The quick-add hotkey: works while writing in a note too. */
export const QUICK_ADD_HOTKEY = 'Mod-Alt-t';

/** Quick add from a task page starts in its context: the list of a list page, today on Today. */
function pageContext(): QuickAddContext {
  const path = appPathname();
  const m = /^\/x\/tasks\/list\/([^/]+)$/.exec(path);
  if (m) return { listId: decodeURIComponent(m[1]) };
  return path === '/x/tasks/today' ? { due: localToday() } : {};
}

function goTo(route: string): void {
  useUi.getState().setDrawerOpen(false);
  navigateTo(route);
}

export function registerTasks(): void {
  if (registered) return;
  registered = true;

  registerPage({ route: 'tasks/today', title: 'Today’s tasks', icon: CalendarCheck, load: () => import('./ui/TodayPage') });
  registerPage({ route: 'tasks/upcoming', title: 'Upcoming tasks', icon: CalendarRange, load: () => import('./ui/UpcomingPage') });
  registerPage({ route: 'tasks', title: 'Task lists', icon: ListTodo, load: () => import('./ui/ListsPage') });
  // Reached from the task pages' tabs and the palette, not the ribbon, which stays short.
  registerPage({ route: 'tasks/completed', title: 'Completed tasks', icon: CircleCheckBig, hidden: true, load: () => import('./ui/CompletedPage') });
  registerPage({ route: 'tasks/filter', title: 'Filter tasks', icon: ListFilter, hidden: true, load: () => import('./ui/FilterPage') });
  registerPage({ route: 'tasks/list/:id', title: 'Task list', icon: ListTodo, hidden: true, load: () => import('./ui/ListPage') });
  registerCommand({ id: 'page.tasks/completed', name: 'Open Completed tasks', icon: CircleCheckBig, run: () => goTo('/x/tasks/completed') });
  registerCommand({ id: 'page.tasks/filter', name: 'Open Filter tasks', icon: ListFilter, run: () => goTo('/x/tasks/filter') });

  // A `.tasks` file opens as its list (with its JSON a click away), and `![[List.tasks]]` embeds it.
  registerView({
    id: 'tasks',
    match: (e) => (e.path.toLowerCase().endsWith('.tasks') ? 6 : 0),
    icon: ListTodo,
    textual: false,
    modes: ['read'],
    load: () => import('./ui/TaskFileView'),
    loadEmbed: () => import('./ui/TaskListEmbed'),
  });

  registerPanel({ id: 'tasks', side: 'right', title: 'Tasks linking to this note', icon: ListChecks, load: () => import('./ui/TasksPanel') });
  registerCommand({
    id: 'tasks.quickAdd',
    name: 'Add task (quick add)',
    hotkey: QUICK_ADD_HOTKEY,
    globalHotkey: true,
    icon: SquarePlus,
    run: () => openQuickAdd(pageContext()),
  });
  registerCommand({
    id: 'tasks.convertCheckbox',
    name: 'Convert checkbox to task',
    icon: SquareCheck,
    when: () => checkboxAtCursor() !== null,
    run: async () => {
      await convertCheckboxToTask();
    },
  });
  registerOverlay({ id: 'tasks', component: TaskOverlays });
  installTaskSync(taskStore, queryClient, registerEventHandler);
}
