// Making script results stale (DESIGN §6.43.3) without loading the editor: the always-loaded event
// handlers (./register.ts) call `invalidateLoadedScripts`, and the Live Preview blocks' module
// (editor/livePreview/scripts.ts), part of the editor's chunk, provides the invalidator when it
// loads. Before then no block has run, so there is nothing to make stale.
type Invalidator = (paths: readonly string[] | null) => void;

let invalidator: Invalidator | null = null;

export function provideScriptInvalidator(f: Invalidator): void {
  invalidator = f;
}

/** Marks the results that read one of `paths` (null: any note) stale, if any script has run. */
export function invalidateLoadedScripts(paths: readonly string[] | null): void {
  invalidator?.(paths);
}
