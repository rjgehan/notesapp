// Where a DocumentSession finds its CodeMirror parts (sessionKit.ts, a lazy chunk). A session reads
// its file and loads the kit at the same time; it touches text only after both arrived.
import type { SessionKit } from './sessionKit';

let kit: SessionKit | null = null;

export function provideSessionKit(k: SessionKit): void {
  kit = k;
}

/** The kit once loaded, else null. */
export function loadedSessionKit(): SessionKit | null {
  return kit;
}

/** The kit, loading it first when needed. */
export function loadSessionKit(): Promise<SessionKit> {
  return kit ? Promise.resolve(kit) : import('./sessionKit').then((m) => m.sessionKit);
}

/** The kit, for code that runs only once the session has loaded (it is there by then). */
export function sessionKit(): SessionKit {
  if (!kit) throw new Error('The session kit is used before it was loaded');
  return kit;
}
