// The formula engine is a lazy chunk (DESIGN §6.21): nothing imports engine.ts statically, so
// HyperFormula loads only when a sheet is edited, never for embeds, search or merges.
export type SheetEngine = typeof import('./engine');

let loading: Promise<SheetEngine> | null = null;

export function loadSheetEngine(): Promise<SheetEngine> {
  loading ??= import('./engine').catch((e: unknown) => {
    loading = null; // a failed chunk load (offline, a deploy) may be retried
    throw e;
  });
  return loading;
}
