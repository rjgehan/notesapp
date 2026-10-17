// Structured tasks (ROADMAP item 4) plugged in through the extension points (DESIGN §6.8, §6.22):
// the Today, list index and list pages, the "Tasks linking to this note" panel, the quick-add
// command with its hotkey, the overlay host of the quick-add dialog and the detail sheet, and
// the live updates of the task events. Everything heavy loads lazily with the pages.
import { CalendarCheck, ListChecks, ListTodo, SquarePlus } from 'lucide-react';
import { queryClient } from '../api/queryClient';
import { registerCommand, registerEventHandler, registerOverlay, registerPage, registerPanel } from '../extensions';
import { taskStore } from './store';
import { installTaskSync } from './sync';
import { TaskOverlays } from './ui/TaskOverlays';
import { localToday } from './dates';
import { openQuickAdd, type QuickAddContext } from './ui/state';
import './tasks.css';

let registered = false;

/** The quick-add hotkey: works while writing in a note too. */
export const QUICK_ADD_HOTKEY = 'Mod-Alt-t';

/** Quick add from a task page starts in its context: the list of a list page, today on Today. */
function pageContext(): QuickAddContext {
  const path = window.location.pathname;
  const m = /^\/x\/tasks\/list\/([^/]+)$/.exec(path);
  if (m) return { listId: decodeURIComponent(m[1]) };
  return path === '/x/tasks/today' ? { due: localToday() } : {};
}

export function registerTasks(): void {
  if (registered) return;
  registered = true;

  registerPage({ route: 'tasks/today', title: 'Today’s tasks', icon: CalendarCheck, load: () => import('./ui/TodayPage') });
  registerPage({ route: 'tasks', title: 'Task lists', icon: ListTodo, load: () => import('./ui/ListsPage') });
  registerPage({ route: 'tasks/list/:id', title: 'Task list', icon: ListTodo, hidden: true, load: () => import('./ui/ListPage') });
  registerPanel({ id: 'tasks', side: 'right', title: 'Tasks linking to this note', icon: ListChecks, load: () => import('./ui/TasksPanel') });
  registerCommand({
    id: 'tasks.quickAdd',
    name: 'Add task (quick add)',
    hotkey: QUICK_ADD_HOTKEY,
    globalHotkey: true,
    icon: SquarePlus,
    run: () => openQuickAdd(pageContext()),
  });
  registerOverlay({ id: 'tasks', component: TaskOverlays });
  installTaskSync(taskStore, queryClient, registerEventHandler);
}
