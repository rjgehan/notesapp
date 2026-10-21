import { describe, expect, it } from 'vitest';
import type { GraphResponse } from '../../api/types';
import { ForceLayout } from './forces';
import { adjacency, baseGraph, buildView, graphFolders, graphTags, groupColors, type ViewGraph } from './model';
import { firstSource } from './open';
import { DEFAULT_GRAPH_OPTIONS, DEFAULT_LOCAL_OPTIONS, obsidianColor, optionsFromObsidian, sanitizeLocalOptions, sanitizeOptions, type FilterOptions } from './options';
import { compileQuery, parseQuery, type QueryNode } from './query';
import { LayoutRunner, type PositionsMessage } from './runner';

const node = (path: string, tags: string[] = [], type: QueryNode['type'] = 'note', aliases: string[] = []): QueryNode => ({
  path,
  label: path.replace(/^.*\//, '').replace(/\.md$/, ''),
  type,
  tags,
  aliases,
});

describe('graph queries', () => {
  it('parses words, phrases, filters and negation', () => {
    expect(parseQuery('plan "weekly review" tag:#Work -path:Archive file:"a b"')).toEqual([
      { kind: 'text', value: 'plan', negated: false },
      { kind: 'text', value: 'weekly review', negated: false },
      { kind: 'tag', value: 'work', negated: false },
      { kind: 'path', value: 'archive', negated: true },
      { kind: 'file', value: 'a b', negated: false },
    ]);
    expect(parseQuery('   ')).toEqual([]);
    expect(parseQuery('- x')).toEqual([
      { kind: 'text', value: '-', negated: false },
      { kind: 'text', value: 'x', negated: false },
    ]);
  });

  it('matches names, paths, aliases and nested tags, accent-insensitively', () => {
    const plan = node('Projects/Plan.md', ['project/alpha'], 'note', ['Roadmap']);
    expect(compileQuery('plan')(plan)).toBe(true);
    expect(compileQuery('roadmap')(plan)).toBe(true);
    expect(compileQuery('tag:project')(plan)).toBe(true);
    expect(compileQuery('tag:#project/alpha')(plan)).toBe(true);
    expect(compileQuery('tag:proj')(plan)).toBe(false);
    expect(compileQuery('path:projects -file:plan')(plan)).toBe(false);
    expect(compileQuery('file:plan.md')(plan)).toBe(true);
    expect(compileQuery('#project')(plan)).toBe(true);
    expect(compileQuery('café')(node('Cafe notes.md'))).toBe(true);
    expect(compileQuery('')(plan)).toBe(true);
  });

  it('matches tag nodes by their tag only', () => {
    const tag: QueryNode = { path: '', label: '#project/alpha', type: 'tag', tags: [], aliases: [] };
    expect(compileQuery('tag:project')(tag)).toBe(true);
    expect(compileQuery('path:project')(tag)).toBe(false);
  });
});

const response: GraphResponse = {
  version: 'v1',
  unchanged: false,
  nodes: [
    { path: 'Hub.md', type: 'note', tags: ['project'] },
    { path: 'Projects/A.md', type: 'note', tags: ['project/alpha'] },
    { path: 'Projects/B.md', type: 'note', tags: [] },
    { path: 'Daily/2026-10-21.md', type: 'note', tags: ['daily'] },
    { path: 'Lonely.md', type: 'note', tags: [] },
    { path: 'Attachments/pic.png', type: 'attachment', tags: [] },
    { path: 'Attachments/unused.pdf', type: 'attachment', tags: [] },
    { path: 'Someday', type: 'unresolved', tags: [] },
  ],
  // Hub → A (2 links), A → Hub, Hub → B, B → Daily, Daily → pic, A → Someday
  edges: [0, 1, 2, 1, 0, 1, 0, 2, 1, 2, 3, 1, 3, 5, 1, 1, 7, 1],
};

const all: FilterOptions = { ...DEFAULT_GRAPH_OPTIONS, showAttachments: true };

function paths(view: ViewGraph): string[] {
  return view.nodes.map((n) => n.id);
}

function links(view: ViewGraph): string[] {
  const out: string[] = [];
  for (let k = 0; k < view.links.length; k += 3) out.push(`${view.nodes[view.links[k]!]!.id}-${view.nodes[view.links[k + 1]!]!.id}:${view.links[k + 2]}`);
  return out.sort();
}

describe('graph model', () => {
  const base = baseGraph(response, (p) => (p === 'Hub.md' ? ['Center'] : []));

  it('gives every node a stable id and a label', () => {
    expect(base.nodes.map((n) => [n.id, n.label])).toEqual([
      ['Hub.md', 'Hub'],
      ['Projects/A.md', 'A'],
      ['Projects/B.md', 'B'],
      ['Daily/2026-10-21.md', '2026-10-21'],
      ['Lonely.md', 'Lonely'],
      ['Attachments/pic.png', 'pic.png'],
      ['Attachments/unused.pdf', 'unused.pdf'],
      ['?someday', 'Someday'],
    ]);
    expect(base.nodes[0]!.aliases).toEqual(['Center']);
    expect(graphTags(base)).toEqual(['daily', 'project', 'project/alpha']);
    expect(graphFolders(base)).toEqual(['Daily', 'Projects']);
    expect(firstSource(base, 7)).toBe('Projects/A.md');
    expect(firstSource(base, 4)).toBeNull();
  });

  it('merges both directions of a pair into one link and counts degrees', () => {
    const view = buildView(base, all);
    expect(links(view)).toEqual([
      'Daily/2026-10-21.md-Attachments/pic.png:1',
      'Hub.md-Projects/A.md:3',
      'Hub.md-Projects/B.md:1',
      'Projects/A.md-?someday:1',
      'Projects/B.md-Daily/2026-10-21.md:1',
    ]);
    expect(view.nodes.find((n) => n.id === 'Hub.md')!.degree).toBe(2);
    expect(view.nodes.find((n) => n.id === 'Lonely.md')!.degree).toBe(0);
    expect(view.center).toBe(-1);
  });

  it('hides attachments, unresolved links and orphans on request', () => {
    expect(paths(buildView(base, { ...all, showAttachments: false }))).not.toContain('Attachments/pic.png');
    expect(paths(buildView(base, { ...all, hideUnresolved: true }))).not.toContain('?someday');
    const noOrphans = paths(buildView(base, { ...all, showOrphans: false }));
    expect(noOrphans).not.toContain('Lonely.md');
    expect(noOrphans).not.toContain('Attachments/unused.pdf');
    expect(noOrphans).toContain('Hub.md');
  });

  it('adds tags as nodes linked to their notes', () => {
    const view = buildView(base, { ...all, showTags: true });
    expect(paths(view)).toEqual(expect.arrayContaining(['#project', '#project/alpha', '#daily']));
    expect(links(view)).toContain('Hub.md-#project:1');
    expect(view.nodes.find((n) => n.id === '#project')!.label).toBe('#project');
  });

  it('filters notes by folder and tag, keeping only the attachments they link to', () => {
    const projects = buildView(base, { ...all, folder: 'Projects' });
    expect(paths(projects)).toEqual(['Projects/A.md', 'Projects/B.md', '?someday']);
    const tagged = buildView(base, { ...all, tag: 'project' });
    expect(paths(tagged)).toEqual(['Hub.md', 'Projects/A.md', '?someday']);
    const daily = buildView(base, { ...all, tag: 'daily' });
    expect(paths(daily)).toEqual(['Daily/2026-10-21.md', 'Attachments/pic.png']);
  });

  it('filters every node with the search query', () => {
    expect(paths(buildView(base, { ...all, search: 'path:Projects' }))).toEqual(['Projects/A.md', 'Projects/B.md']);
    expect(paths(buildView(base, { ...all, search: 'center' }))).toEqual(['Hub.md']);
    expect(paths(buildView(base, { ...all, search: '-path:Attachments -someday' }))).toEqual(['Hub.md', 'Projects/A.md', 'Projects/B.md', 'Daily/2026-10-21.md', 'Lonely.md']);
  });

  it('builds the local graph by depth and direction', () => {
    const local = (opts: Partial<typeof DEFAULT_LOCAL_OPTIONS>, path = 'Projects/B.md') => {
      const o = { ...DEFAULT_LOCAL_OPTIONS, showAttachments: true, ...opts };
      return buildView(base, o, { path, depth: o.depth, incoming: o.incoming, outgoing: o.outgoing, neighborLinks: o.neighborLinks });
    };
    const one = local({ depth: 1 });
    expect(paths(one)).toEqual(['Hub.md', 'Projects/B.md', 'Daily/2026-10-21.md']);
    expect(one.nodes[one.center]!.id).toBe('Projects/B.md');
    expect(paths(local({ depth: 2 }))).toEqual(['Hub.md', 'Projects/A.md', 'Projects/B.md', 'Daily/2026-10-21.md', 'Attachments/pic.png']);
    expect(paths(local({ depth: 1, incoming: false }))).toEqual(['Projects/B.md', 'Daily/2026-10-21.md']);
    expect(paths(local({ depth: 1, outgoing: false }))).toEqual(['Hub.md', 'Projects/B.md']);
    // A file that is not in the graph has no local graph.
    expect(local({}, 'Missing.md').nodes).toEqual([]);
    // The center stays even when a filter would hide it.
    expect(paths(local({ depth: 1, hideUnresolved: true }, 'Projects/A.md'))).toEqual(['Hub.md', 'Projects/A.md']);
  });

  it('leaves out links between neighbours at the same depth without neighbour links', () => {
    const triangle = baseGraph({
      version: 't',
      unchanged: false,
      nodes: [
        { path: 'C.md', type: 'note', tags: [] },
        { path: 'X.md', type: 'note', tags: [] },
        { path: 'Y.md', type: 'note', tags: [] },
      ],
      edges: [0, 1, 1, 0, 2, 1, 1, 2, 1],
    });
    const scope = { path: 'C.md', depth: 1, incoming: true, outgoing: true };
    expect(links(buildView(triangle, DEFAULT_LOCAL_OPTIONS, { ...scope, neighborLinks: true }))).toHaveLength(3);
    expect(links(buildView(triangle, DEFAULT_LOCAL_OPTIONS, { ...scope, neighborLinks: false }))).toEqual(['C.md-X.md:1', 'C.md-Y.md:1']);
  });

  it('colors each node with the first matching group', () => {
    const view = buildView(base, { ...all, showTags: true });
    const colors = groupColors(view.nodes, [
      { query: 'tag:project', color: '#ff0000' },
      { query: 'path:Projects', color: '#00ff00' },
      { query: '', color: '#0000ff' },
    ]);
    const colorOf = (id: string) => colors[view.nodes.findIndex((n) => n.id === id)];
    expect(colorOf('Hub.md')).toBe('#ff0000');
    expect(colorOf('Projects/A.md')).toBe('#ff0000');
    expect(colorOf('Projects/B.md')).toBe('#00ff00');
    expect(colorOf('#project')).toBe('#ff0000');
    expect(colorOf('Lonely.md')).toBeNull();
  });

  it('lists the neighbours of every node', () => {
    const view = buildView(base, all);
    const adj = adjacency(view);
    const hub = view.nodes.findIndex((n) => n.id === 'Hub.md');
    const neighbours = [...adj.targets.slice(adj.offsets[hub], adj.offsets[hub + 1])].map((i) => view.nodes[i]!.id).sort();
    expect(neighbours).toEqual(['Projects/A.md', 'Projects/B.md']);
  });
});

describe('graph options', () => {
  it('clamps and checks stored options', () => {
    const o = sanitizeOptions({ repelStrength: 99, linkDistance: -5, showTags: 'yes', colorGroups: [{ query: 'a', color: '#ABCDEF' }, { query: 'b', color: 'red' }, null] });
    expect(o.repelStrength).toBe(20);
    expect(o.linkDistance).toBe(30);
    expect(o.showTags).toBe(false);
    expect(o.colorGroups).toEqual([{ query: 'a', color: '#abcdef' }]);
    expect(sanitizeOptions(null)).toEqual(DEFAULT_GRAPH_OPTIONS);
    expect(sanitizeLocalOptions({ depth: 9.4, incoming: false }).depth).toBe(5);
    expect(sanitizeLocalOptions({ depth: 9.4, incoming: false }).incoming).toBe(false);
  });

  it("converts Obsidian's graph.json", () => {
    expect(obsidianColor({ a: 1, rgb: 14701138 })).toBe('#e05252');
    expect(obsidianColor({ rgb: -1 })).toBeNull();
    const o = optionsFromObsidian({
      'collapse-filter': true,
      search: 'path:Work',
      showTags: true,
      showAttachments: false,
      hideUnresolved: true,
      showOrphans: false,
      colorGroups: [{ query: 'tag:#project', color: { a: 1, rgb: 5431473 } }, { query: 'bad', color: {} }],
      showArrow: true,
      textFadeMultiplier: -1.2,
      nodeSizeMultiplier: 1.4,
      lineSizeMultiplier: 0.8,
      centerStrength: 0.518713248970312,
      repelStrength: 12.5,
      linkStrength: 0.7,
      linkDistance: 180,
      scale: 0.9,
    });
    expect(o).toMatchObject({
      search: 'path:Work',
      showTags: true,
      hideUnresolved: true,
      showOrphans: false,
      showArrow: true,
      textFadeMultiplier: -1.2,
      repelStrength: 12.5,
      linkDistance: 180,
      colorGroups: [{ query: 'tag:#project', color: '#52e0b1' }],
      folder: '',
    });
  });
});

describe('force layout', () => {
  const forces = DEFAULT_GRAPH_OPTIONS;

  it('settles a graph and keeps positions by id across updates', () => {
    const layout = new ForceLayout(forces);
    layout.setGraph({ ids: ['a', 'b', 'c'], links: Int32Array.from([0, 1, 1, 2]) }, 1);
    for (let i = 0; i < 400 && layout.running; i++) layout.tick();
    expect(layout.running).toBe(false);
    const before = layout.positions();
    expect([...before].every(Number.isFinite)).toBe(true);
    // Linked nodes end up closer than unlinked ones.
    const d = (p: Float32Array, i: number, j: number) => Math.hypot(p[i * 2]! - p[j * 2]!, p[i * 2 + 1]! - p[j * 2 + 1]!);
    expect(d(before, 0, 1)).toBeLessThan(d(before, 0, 2));

    layout.setGraph({ ids: ['c', 'a', 'd'], links: Int32Array.from([1, 2]) }, 0);
    const after = layout.positions();
    expect(after[0]).toBeCloseTo(before[4]!, 3);
    expect(after[2]).toBeCloseTo(before[0]!, 3);
    // The new node starts next to its placed neighbour.
    expect(d(after, 1, 2)).toBeLessThan(40);
  });

  it('holds a dragged node where the pointer is', () => {
    const layout = new ForceLayout(forces);
    layout.setGraph({ ids: ['a', 'b'], links: Int32Array.from([0, 1]) }, 1);
    layout.drag(0, 500, -200);
    layout.tick(5);
    const p = layout.positions();
    expect(p[0]).toBe(500);
    expect(p[1]).toBe(-200);
    expect(layout.running).toBe(true);
    layout.release(0);
    for (let i = 0; i < 1000 && layout.running; i++) layout.tick();
    expect(layout.running).toBe(false);
  });

  it('runs in slices and posts positions for the current generation', async () => {
    const messages: PositionsMessage[] = [];
    const runner = new LayoutRunner(forces, (m) => messages.push(m), 50, 0);
    runner.handle({ type: 'graph', ids: ['a', 'b'], links: Int32Array.from([0, 1]), reheat: 1, generation: 3 });
    for (let i = 0; i < 100 && (messages.length === 0 || messages.at(-1)!.running); i++) await new Promise((r) => setTimeout(r, 5));
    runner.dispose();
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.at(-1)!.running).toBe(false);
    expect(messages.every((m) => m.generation === 3 && m.positions.length === 4)).toBe(true);
  });
});
