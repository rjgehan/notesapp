// The formula engine for notes is a lazy chunk (ROADMAP item 39, DESIGN §6.38): HyperFormula loads
// the first time a note with formulas shows, never for notes without them. Editors waiting for it
// subscribe, and redraw once it is in.
export type FormulaEngine = typeof import('./engine');

let loaded: FormulaEngine | null = null;
let loading: Promise<FormulaEngine> | null = null;
const waiting = new Set<() => void>();

/** The engine if its chunk has loaded, else null. */
export function loadedFormulaEngine(): FormulaEngine | null {
  return loaded;
}

/** Loads the engine (once); `then` runs when it is in (at once if it already is). */
export function loadFormulaEngine(then?: () => void): void {
  if (loaded) {
    then?.();
    return;
  }
  if (then) waiting.add(then);
  loading ??= import('./engine').then(
    (m) => {
      loaded = m;
      const callbacks = [...waiting];
      waiting.clear();
      for (const f of callbacks) f();
      return m;
    },
    (e: unknown) => {
      // A failed chunk load (offline, a deploy) is retried the next time a formula shows.
      loading = null;
      console.warn('[formulas] loading the formula engine failed', e);
      throw e;
    },
  );
  loading.catch(() => {});
}

/** The engine, loading it if needed (scripts' `fn` and `formula`, ROADMAP 40b). */
export function formulaEngine(): Promise<FormulaEngine> {
  if (loaded) return Promise.resolve(loaded);
  return new Promise((resolve, reject) => {
    loadFormulaEngine(() => resolve(loaded!));
    loading?.catch(reject);
  });
}

/** Stops waiting (an editor that went away before the engine loaded). */
export function cancelFormulaWait(then: () => void): void {
  waiting.delete(then);
}

/** Tests: the engine, loaded. */
export async function formulaEngineForTests(): Promise<FormulaEngine> {
  loaded ??= await import('./engine');
  return loaded;
}
