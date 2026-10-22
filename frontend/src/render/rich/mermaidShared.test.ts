import { describe, expect, it, vi } from 'vitest';

// A stand-in for Mermaid's single global configuration, recording the one each call ran under.
const fake = vi.hoisted(() => {
  let config: Record<string, unknown> = {};
  const calls: string[] = [];
  let release: (() => void) | null = null;
  return {
    calls,
    hold: () => new Promise<void>((done) => (release = done)),
    release: () => release?.(),
    mermaid: {
      initialize: (c: Record<string, unknown>) => {
        config = c;
      },
      render: async (id: string) => {
        calls.push(`render ${id}: ${String(config.theme)} ${String(config.layout)}`);
        if (id === 'slow') await new Promise<void>((done) => (release = done));
        return { svg: '' };
      },
      parse: async () => true,
      mermaidAPI: Object.freeze({
        getDiagramFromText: async (text: string) => {
          calls.push(`diagram ${text}: ${String(config.theme)} ${String(config.layout)}`);
          return {};
        },
      }),
    },
  };
});
vi.mock('mermaid/dist/mermaid.core.mjs', () => ({ default: fake.mermaid }));

describe('one Mermaid for the app and for Excalidraw', () => {
  it('runs each side with its own configuration, always with dagre, one call at a time', async () => {
    const { appMermaid, default: other } = await import('./mermaidShared');
    appMermaid.initialize({ theme: 'dark' });
    other.initialize({ theme: 'default' });
    const slow = appMermaid.render('slow', 'graph TD');
    const diagram = other.mermaidAPI.getDiagramFromText('flowchart');
    const app = appMermaid.render('fast', 'graph TD');
    await vi.waitFor(() => expect(fake.calls).toEqual(['render slow: dark dagre']));
    // Excalidraw's call waits for the app's rendering, so its configuration never changes under it.
    fake.release();
    await Promise.all([slow, diagram, app]);
    expect(fake.calls).toEqual(['render slow: dark dagre', 'diagram flowchart: default dagre', 'render fast: dark dagre']);
  });

  it('forces dagre even when a side asks for ELK', async () => {
    const { default: other } = await import('./mermaidShared');
    other.initialize({ theme: 'forest', layout: 'elk' });
    await other.render('x', 'graph TD');
    expect(fake.calls.at(-1)).toBe('render x: forest dagre');
  });
});
