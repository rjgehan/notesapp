// The page's side of the graph layout (ROADMAP item 16, DESIGN §6.28): a Web Worker when the
// browser can start one, otherwise the same runner on the page. A worker that fails to load
// (an old browser, a blocked script) is replaced by the inline runner with the same state.
import type { LayoutGraph } from './forces';
import type { ForceOptions } from './options';
import { LayoutRunner, type LayoutMessage, type PositionsMessage } from './runner';

export interface LayoutClient {
  /** Replaces the graph; returns its generation (positions of older generations are ignored). */
  setGraph(graph: LayoutGraph, reheat: number): number;
  setForces(forces: ForceOptions): void;
  drag(index: number, x: number, y: number): void;
  release(index: number): void;
  dispose(): void;
  /** 'worker' or 'inline', for diagnostics. */
  readonly mode: 'worker' | 'inline';
}

export function createLayoutClient(forces: ForceOptions, onPositions: (message: PositionsMessage) => void, preferWorker = true): LayoutClient {
  let generation = 0;
  let lastGraph: Extract<LayoutMessage, { type: 'graph' }> | null = null;
  let lastForces: ForceOptions = forces;
  let inline: LayoutRunner | null = null;
  let worker: Worker | null = null;
  let disposed = false;

  const deliver = (message: PositionsMessage) => {
    if (!disposed && message.generation === generation) onPositions(message);
  };

  const startInline = () => {
    inline = new LayoutRunner(lastForces, deliver, 6, 16);
    if (lastGraph) inline.handle({ ...lastGraph, links: lastGraph.links.slice() });
  };

  if (preferWorker && typeof Worker !== 'undefined') {
    try {
      worker = new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<PositionsMessage>) => deliver(event.data);
      worker.onerror = (event) => {
        event.preventDefault?.();
        worker?.terminate();
        worker = null;
        if (!disposed) {
          send({ type: 'forces', forces: lastForces });
          startInline();
        }
      };
    } catch {
      worker = null;
    }
  }

  function send(message: LayoutMessage, transfer: Transferable[] = []): void {
    if (worker) worker.postMessage(message, transfer);
    else inline?.handle(message);
  }

  const client: LayoutClient = {
    get mode() {
      return worker ? 'worker' : 'inline';
    },
    setGraph(graph, reheat) {
      generation++;
      lastGraph = { type: 'graph', ids: graph.ids, links: graph.links, reheat, generation };
      // The worker gets its own copy of the links; the page keeps lastGraph for a fallback.
      send({ ...lastGraph, links: graph.links.slice() });
      return generation;
    },
    setForces(next) {
      lastForces = next;
      send({ type: 'forces', forces: next });
    },
    drag(index, x, y) {
      send({ type: 'drag', index, x, y, generation });
    },
    release(index) {
      send({ type: 'release', index, generation });
    },
    dispose() {
      disposed = true;
      worker?.terminate();
      worker = null;
      inline?.dispose();
      inline = null;
    },
  };
  send({ type: 'forces', forces });
  if (!worker) startInline();
  return client;
}
