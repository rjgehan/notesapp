// A view's semantic merge (DESIGN §6.8) kept out of the main chunk: drawings and spreadsheets parse
// their formats to merge, which is code the first paint of a note does not need. A session merges
// synchronously when a conflict arrives, so the merge has to be loaded before then: the view's
// chunks load it (`preload`, in its `load` and `loadEmbed`), a session of such a file belongs to a
// view that has loaded, and asking before it arrived starts the load and answers null, which shows
// the conflict banner, as for a view without a merge.
type Merge = (base: string, mine: string, theirs: string) => string | null;

export interface LazyMerge {
  /** The descriptor's `merge`. */
  merge: Merge;
  /** Starts loading the merge (once). */
  preload(): void;
  /** Loads the merge; tests and code that must have it await this. */
  ready(): Promise<void>;
}

export function lazyMerge(load: () => Promise<Merge>): LazyMerge {
  let loaded: Merge | null = null;
  let loading: Promise<void> | null = null;
  const ready = (): Promise<void> => {
    loading ??= load().then(
      (m) => {
        loaded = m;
      },
      (e: unknown) => {
        // Not fatal: conflicts show the banner; a later preload tries again.
        loading = null;
        console.warn('[notesapp] could not load a merge', e);
      },
    );
    return loading;
  };
  return {
    merge: (base, mine, theirs) => {
      if (loaded) return loaded(base, mine, theirs);
      void ready();
      return null;
    },
    preload: () => void ready(),
    ready,
  };
}

/** `load` that preloads `merge` alongside the chunk it loads. */
export function withMerge<T>(merge: LazyMerge, load: () => Promise<T>): () => Promise<T> {
  return () => {
    merge.preload();
    return load();
  };
}
