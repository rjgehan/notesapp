// Links to one task from a note (API.md §20.9): `[[Inbox.tasks#^<task id>]]`, the list's file with
// the task's id written as an Obsidian block reference. Obsidian keeps it as a link to the file;
// NotesApp opens the task (the `tasks` file view reads the subpath), wherever the task lives now.

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The subpath of a link to a task: `^<id>`. */
export function taskSubpath(taskId: string): string {
  return `^${taskId}`;
}

/** The task a link's subpath (`^<id>`) or a location's hash (`#%5E<id>`) names, or null. */
export function linkedTaskId(subpathOrHash: string | null | undefined): string | null {
  if (!subpathOrHash) return null;
  let sub: string;
  try {
    sub = decodeURIComponent(subpathOrHash.replace(/^#/, ''));
  } catch {
    return null;
  }
  return sub.startsWith('^') && TASK_ID.test(sub.slice(1)) ? sub.slice(1) : null;
}
