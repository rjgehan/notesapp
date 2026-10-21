// Graph options on this device (ROADMAP item 16): the global graph's and the local graph's,
// persisted in localStorage after a short pause so dragging a slider writes once.
import { create } from 'zustand';
import { GRAPH_KEY, loadOptions, LOCAL_GRAPH_KEY, sanitizeLocalOptions, sanitizeOptions, saveOptions, type GraphOptions, type LocalGraphOptions } from './options';

interface GraphOptionsState {
  global: GraphOptions;
  local: LocalGraphOptions;
  setGlobal(patch: Partial<GraphOptions>): void;
  setLocal(patch: Partial<LocalGraphOptions>): void;
  replaceGlobal(options: GraphOptions): void;
}

const SAVE_DELAY_MS = 400;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function saveLater(key: string, options: object): void {
  const pending = timers.get(key);
  if (pending) clearTimeout(pending);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      saveOptions(key, options);
    }, SAVE_DELAY_MS),
  );
}

export const useGraphOptions = create<GraphOptionsState>()((set, get) => ({
  global: loadOptions(GRAPH_KEY, (raw) => sanitizeOptions(raw)),
  local: loadOptions(LOCAL_GRAPH_KEY, sanitizeLocalOptions),
  setGlobal(patch) {
    set({ global: { ...get().global, ...patch } });
    saveLater(GRAPH_KEY, get().global);
  },
  setLocal(patch) {
    set({ local: { ...get().local, ...patch } });
    saveLater(LOCAL_GRAPH_KEY, get().local);
  },
  replaceGlobal(options) {
    set({ global: options });
    saveLater(GRAPH_KEY, options);
  },
}));
