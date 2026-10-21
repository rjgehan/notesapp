// The force layout behind the graph view (ROADMAP item 16, DESIGN §6.21): d3-force with
// Obsidian's four forces (center, repel, link strength, link distance). It runs in a Web Worker
// (layout.worker.ts) so a 10,000-note graph never blocks the page, or inline where workers are
// unavailable. Nodes keep their position across updates by id, so filtering or a live update
// moves only what changed.
import { forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import type { ForceOptions } from './options';

export interface LayoutNode extends SimulationNodeDatum {
  id: string;
  index?: number;
}

type LayoutLink = SimulationLinkDatum<LayoutNode>;

export interface LayoutGraph {
  ids: string[];
  /** Flat pairs [a, b] of node indexes. */
  links: Int32Array;
}

/** Obsidian's slider values in d3 units. */
export function d3Forces(f: ForceOptions): { center: number; charge: number; distance: number; linkScale: number } {
  return {
    center: f.centerStrength * 0.08,
    charge: -f.repelStrength * 8,
    distance: f.linkDistance * 0.16,
    linkScale: f.linkStrength,
  };
}

export const ALPHA_MIN = 0.002;

export class ForceLayout {
  private readonly sim: Simulation<LayoutNode, LayoutLink>;
  private readonly byId = new Map<string, LayoutNode>();
  private nodes: LayoutNode[] = [];
  private forces: ForceOptions;
  private dragging = -1;
  private currentLinks: Int32Array = new Int32Array(0);

  constructor(forces: ForceOptions) {
    this.forces = forces;
    // stop(): ticks are driven by the caller, never by d3-timer.
    this.sim = forceSimulation<LayoutNode, LayoutLink>([]).stop().alphaMin(ALPHA_MIN).velocityDecay(0.45);
    this.applyForces();
  }

  get alpha(): number {
    return this.sim.alpha();
  }

  get size(): number {
    return this.nodes.length;
  }

  /** True while the layout still moves (or a node is held). */
  get running(): boolean {
    return this.dragging >= 0 || this.sim.alpha() >= ALPHA_MIN;
  }

  private applyForces(): void {
    const f = d3Forces(this.forces);
    const count = this.nodes.length;
    // Barnes–Hut with a looser theta and a bounded range keeps large graphs fast.
    this.sim.force('charge', forceManyBody<LayoutNode>().strength(f.charge).theta(count > 5000 ? 1.4 : count > 2000 ? 1.1 : 0.9).distanceMax(f.distance * 10));
    // Big graphs settle in about 150 ticks instead of 300.
    this.sim.alphaDecay(count > 3000 ? 0.045 : 0.0228);
    this.sim.force('x', forceX<LayoutNode>(0).strength(f.center));
    this.sim.force('y', forceY<LayoutNode>(0).strength(f.center));
  }

  setForces(forces: ForceOptions): void {
    this.forces = forces;
    this.applyForces();
    this.setLinks(this.currentLinks);
    this.sim.alpha(Math.max(this.sim.alpha(), 0.3));
  }

  private setLinks(links: Int32Array): void {
    this.currentLinks = links;
    const f = d3Forces(this.forces);
    const data: LayoutLink[] = [];
    for (let k = 0; k + 1 < links.length; k += 2) data.push({ source: links[k]!, target: links[k + 1]! });
    const force = forceLink<LayoutNode, LayoutLink>(data).distance(f.distance);
    // d3's default strength (1 / smaller degree) keeps hubs stable; the slider scales it.
    const count = new Int32Array(this.nodes.length);
    for (const l of data) {
      count[l.source as number]!++;
      count[l.target as number]!++;
    }
    force.strength((l) => f.linkScale / Math.max(1, Math.min(count[(l.source as LayoutNode).index!]!, count[(l.target as LayoutNode).index!]!)));
    this.sim.force('link', force);
  }

  /**
   * Replaces the graph. Known ids keep their position and speed; a new node starts next to an
   * already placed neighbour, or on d3's spiral when it has none. `reheat` is the alpha to resume
   * with (1 for a fresh layout, lower for a small change).
   */
  setGraph(graph: LayoutGraph, reheat: number): void {
    const next: LayoutNode[] = new Array(graph.ids.length);
    const placed = new Uint8Array(graph.ids.length);
    for (let i = 0; i < graph.ids.length; i++) {
      const id = graph.ids[i]!;
      const old = this.byId.get(id);
      if (old && old.x !== undefined && Number.isFinite(old.x)) {
        next[i] = old;
        placed[i] = 1;
      } else {
        next[i] = { id };
      }
    }
    // New nodes next to a placed neighbour (two passes reach chains of new notes).
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k + 1 < graph.links.length; k += 2) {
        const a = graph.links[k]!;
        const b = graph.links[k + 1]!;
        if (placed[a] && !placed[b]) place(next[b]!, next[a]!, placed, b);
        else if (placed[b] && !placed[a]) place(next[a]!, next[b]!, placed, a);
      }
    }
    this.byId.clear();
    for (const node of next) {
      // A node held by the pointer is let go: indexes change with the graph.
      node.fx = null;
      node.fy = null;
      this.byId.set(node.id, node);
    }
    this.nodes = next;
    this.dragging = -1;
    this.sim.alphaTarget(0);
    this.sim.nodes(next);
    this.applyForces();
    this.setLinks(graph.links);
    this.sim.alpha(Math.max(this.sim.alpha(), reheat));
  }

  tick(count = 1): void {
    this.sim.tick(count);
  }

  /** x0, y0, x1, y1, … for the current nodes. */
  positions(out: Float32Array = new Float32Array(this.nodes.length * 2)): Float32Array {
    for (let i = 0; i < this.nodes.length; i++) {
      const node = this.nodes[i]!;
      out[i * 2] = node.x ?? 0;
      out[i * 2 + 1] = node.y ?? 0;
    }
    return out;
  }

  /** Holds a node under the pointer; the layout keeps running around it. */
  drag(index: number, x: number, y: number): void {
    const node = this.nodes[index];
    if (!node) return;
    this.dragging = index;
    node.fx = x;
    node.fy = y;
    this.sim.alphaTarget(0.25);
    if (this.sim.alpha() < 0.25) this.sim.alpha(0.25);
  }

  release(index: number): void {
    const node = this.nodes[index];
    if (node) {
      node.fx = null;
      node.fy = null;
    }
    this.dragging = -1;
    this.sim.alphaTarget(0);
  }
}

function place(node: LayoutNode, near: LayoutNode, placed: Uint8Array, index: number): void {
  const angle = Math.random() * Math.PI * 2;
  const r = 10 + Math.random() * 20;
  node.x = (near.x ?? 0) + Math.cos(angle) * r;
  node.y = (near.y ?? 0) + Math.sin(angle) * r;
  node.vx = 0;
  node.vy = 0;
  placed[index] = 1;
}
