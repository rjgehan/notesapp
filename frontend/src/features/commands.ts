// Command registry (DESIGN §6.8, §6.13). Global commands come from registerCommand; commands
// contributed by a view descriptor are active only while that view is shown.
import type { LucideIcon } from 'lucide-react';
import { useSyncExternalStore } from 'react';

export interface CommandContext {
  /** The open file's path, if any. */
  activePath: string | null;
}

export interface Command {
  id: string;
  name: string;
  /** CodeMirror-style key spec, e.g. `Mod-Alt-n`, handled by the global key handler. */
  hotkey?: string;
  /** A key bound by the editor's own keymap; shown in the palette, not handled globally. */
  editorHotkey?: string;
  icon?: LucideIcon;
  /** Hidden from the palette (and its hotkey inert) when this returns false. */
  when?(ctx: CommandContext): boolean;
  run(ctx: CommandContext): void | Promise<void>;
}

const commands = new Map<string, Command>();
const listeners = new Set<() => void>();
let version = 0;

/** Supplies the commands of the active view (DESIGN §6.8 `FileViewDescriptor.commands`). */
let viewCommands: (activePath: string | null) => readonly Command[] = () => [];

export function setViewCommandSource(source: (activePath: string | null) => readonly Command[]): void {
  viewCommands = source;
}

export function registerCommand(c: Command): void {
  commands.set(c.id, c);
  version++;
  for (const l of listeners) l();
}

export function getCommand(id: string): Command | undefined {
  return commands.get(id);
}

export function allCommands(): Command[] {
  return [...commands.values()];
}

/** Global commands plus the active view's, filtered by their `when`. */
export function availableCommands(ctx: CommandContext): Command[] {
  const global = [...commands.values()];
  const local = viewCommands(ctx.activePath).filter((c) => !commands.has(c.id));
  return [...global, ...local].filter((c) => !c.when || c.when(ctx));
}

export function onCommandsChanged(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function commandsVersion(): number {
  return version;
}

export function runCommand(id: string, ctx: CommandContext): boolean {
  const c = commands.get(id) ?? viewCommands(ctx.activePath).find((v) => v.id === id);
  if (!c || (c.when && !c.when(ctx))) return false;
  recordCommandUse(c.id);
  // Synchronous: commands that open an input must focus it inside the user's gesture (§6.13).
  try {
    const result = c.run(ctx);
    if (result) result.catch((e: unknown) => console.error(`[notesapp] command ${id} failed`, e));
  } catch (e) {
    console.error(`[notesapp] command ${id} failed`, e);
  }
  return true;
}

/** Re-renders when commands are registered. */
export function useCommandsVersion(): number {
  return useSyncExternalStore(onCommandsChanged, commandsVersion);
}

// ---------- recently used (palette ordering) ----------

const RECENT_KEY = 'notesapp:recentCommands';
const RECENT_MAX = 20;

export function recentCommandIds(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function recordCommandUse(id: string): void {
  if (id === 'app.commandPalette') return;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentCommandIds().filter((x) => x !== id)].slice(0, RECENT_MAX)));
  } catch {
    // Private mode: ordering is a convenience only.
  }
}
