// "Add property" requests (ROADMAP item 13): the command asks the open note's Properties editor,
// which lives in an editor widget, to open its new-property row. A request made before the editor
// draws (the command just created the frontmatter) waits for it.
type Listener = (path: string) => void;

const listeners = new Set<Listener>();
let pending: string | null = null;

export const addRequests = {
  /** Listens for requests; a request still waiting for `path` is taken at once. */
  subscribe(path: string, fn: Listener): () => void {
    listeners.add(fn);
    if (pending === path) {
      pending = null;
      fn(path);
    }
    return () => listeners.delete(fn);
  },
  request(path: string): void {
    pending = path;
    for (const fn of [...listeners]) fn(path);
  },
  /** An editor took the request. */
  taken(path: string): void {
    if (pending === path) pending = null;
  },
};
