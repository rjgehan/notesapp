// "Add property" requests (ROADMAP item 13): the command asks the open note's Properties editor,
// which lives in an editor widget, to open its new-property row. A request made before the editor
// draws (the command just created the frontmatter) waits for it. With tabs and split panes
// (DESIGN §6.40) one note can be shown by several editors: a request names the editor it is for
// (its `.cm-editor` element), and only the Properties editor inside it answers.
type Listener = (path: string, target: Element | null) => void;

const listeners = new Set<Listener>();
let pending: { path: string; target: Element | null } | null = null;

export const addRequests = {
  /** Listens for requests; a request still waiting for `path` is offered at once. */
  subscribe(path: string, fn: Listener): () => void {
    listeners.add(fn);
    if (pending?.path === path) fn(path, pending.target);
    return () => listeners.delete(fn);
  },
  /** Asks the Properties editor of `path` inside `target` (any one when null) to open its new-property row. */
  request(path: string, target: Element | null = null): void {
    pending = { path, target };
    for (const fn of [...listeners]) fn(path, target);
  },
  /** An editor took the request. */
  taken(path: string): void {
    if (pending?.path === path) pending = null;
  },
};
