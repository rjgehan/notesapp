// The habit tracker (ROADMAP item 35, DESIGN §6.35) through the extension points of DESIGN §6.8:
// the `/x/habits` page, the Habits panel for daily notes, a command, and event handlers that keep
// an open page live when habit or daily notes change on another device.
import { Plus, Target } from 'lucide-react';
import { queryClient } from '../api/queryClient';
import { registerCommand, registerEventHandler, registerPage, registerPanel } from '../extensions';
import { navigateTo } from '../features/navigation';
import { useUi } from '../state/ui';
import { habitKeys } from './api';
import { habitsUrl } from './routes';

/** Habit notes and daily notes are notes: a change to any note may be a check-in. */
const NOTE_EVENTS = ['file.created', 'file.changed', 'file.deleted', 'entry.moved', 'folder.deleted'];
const REFRESH_DEBOUNCE_MS = 500;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRefresh(data: unknown): void {
  const d = data as { path?: string; file?: { path: string }; from?: string; to?: string } | null;
  const paths = [d?.path, d?.file?.path, d?.from, d?.to].filter((p): p is string => typeof p === 'string');
  // Only notes (and folders, which may hold notes) can be habits or daily notes.
  if (paths.length && paths.every((p) => /\.[^/]+$/.test(p) && !p.toLowerCase().endsWith('.md'))) return;
  if (refreshTimer !== null) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void queryClient.invalidateQueries({ queryKey: habitKeys.all });
  }, REFRESH_DEBOUNCE_MS);
}

let registered = false;

export function registerHabits(): void {
  if (registered) return;
  registered = true;
  registerPage({ route: 'habits', title: 'Habits', icon: Target, load: () => import('./ui/HabitsPage') });
  registerPanel({ id: 'habits', side: 'right', title: 'Habits', icon: Target, load: () => import('./ui/HabitsPanel') });
  registerCommand({
    id: 'habits.new',
    name: 'Create new habit',
    icon: Plus,
    run: () => {
      useUi.getState().setDrawerOpen(false);
      navigateTo(habitsUrl({ view: 'new' }));
    },
  });
  for (const name of NOTE_EVENTS) registerEventHandler(name, scheduleRefresh);
}
