// Drives a ForceLayout in time slices and reports positions (ROADMAP item 16, DESIGN §6.21).
// The same runner works inside the layout worker and, where workers are unavailable, on the page.
import { ForceLayout, type LayoutGraph } from './forces';
import type { ForceOptions } from './options';

export type LayoutMessage =
  | { type: 'graph'; ids: string[]; links: Int32Array; reheat: number; generation: number }
  | { type: 'forces'; forces: ForceOptions }
  | { type: 'drag'; index: number; x: number; y: number; generation: number }
  | { type: 'release'; index: number; generation: number };

export interface PositionsMessage {
  type: 'positions';
  positions: Float32Array;
  generation: number;
  alpha: number;
  running: boolean;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class LayoutRunner {
  private layout: ForceLayout;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly post: (message: PositionsMessage) => void;
  /** Milliseconds of ticking per slice. */
  private readonly budgetMs: number;
  /** Pause between slices. */
  private readonly delayMs: number;

  constructor(forces: ForceOptions, post: (message: PositionsMessage) => void, budgetMs: number, delayMs: number) {
    this.layout = new ForceLayout(forces);
    this.post = post;
    this.budgetMs = budgetMs;
    this.delayMs = delayMs;
  }

  handle(message: LayoutMessage): void {
    switch (message.type) {
      case 'graph': {
        const graph: LayoutGraph = { ids: message.ids, links: message.links };
        this.generation = message.generation;
        this.layout.setGraph(graph, message.reheat);
        break;
      }
      case 'forces':
        this.layout.setForces(message.forces);
        break;
      case 'drag':
        if (message.generation === this.generation) this.layout.drag(message.index, message.x, message.y);
        break;
      case 'release':
        if (message.generation === this.generation) this.layout.release(message.index);
        break;
    }
    this.wake(true);
  }

  private wake(soon = false): void {
    if (this.disposed || this.timer !== null) return;
    this.timer = setTimeout(this.step, soon ? 0 : this.delayMs);
  }

  private readonly step = (): void => {
    this.timer = null;
    if (this.disposed) return;
    const start = now();
    while (this.layout.running) {
      this.layout.tick();
      if (now() - start >= this.budgetMs) break;
    }
    const running = this.layout.running;
    this.post({ type: 'positions', positions: this.layout.positions(), generation: this.generation, alpha: this.layout.alpha, running });
    if (running) this.wake();
  };

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
