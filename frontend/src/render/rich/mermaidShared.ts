// One Mermaid for the app's diagrams (mermaid.ts) and Excalidraw's "Mermaid to Excalidraw"
// (@excalidraw/mermaid-to-excalidraw, which package.json's overrides give the app's Mermaid 12
// instead of a second copy). Mermaid keeps one global configuration, which each side sets for
// itself, so they must not see each other's: vite.config.ts puts this module in place of `mermaid`
// for every importer, and each side gets a facade that keeps its own configuration and applies it
// before each of its calls. The calls of both run one at a time, in order, so a configuration never
// changes under a rendering in progress. Every configuration lays out with dagre: ELK, Mermaid 12's
// default, is not in the bundle (elkStub.ts).
import type { MermaidConfig } from 'mermaid';
import mermaid from 'mermaid/dist/mermaid.core.mjs';

type Mermaid = typeof mermaid;
type Owner = 'app' | 'other';

const configs: Record<Owner, MermaidConfig | null> = { app: null, other: null };
let active: Owner | null = null;
let queue: Promise<unknown> = Promise.resolve();

function use(owner: Owner): void {
  const config = configs[owner];
  if (active === owner || !config) return;
  mermaid.initialize({ ...config, layout: 'dagre' });
  active = owner;
}

/** Runs `task` after every earlier call, with `owner`'s configuration in place. */
function run<T>(owner: Owner, task: () => Promise<T>): Promise<T> {
  const next = queue.then(() => {
    use(owner);
    return task();
  });
  queue = next.catch(() => undefined);
  return next;
}

function facade(owner: Owner): Mermaid {
  const api = Object.create(mermaid.mermaidAPI, {
    getDiagramFromText: {
      value: (...args: Parameters<Mermaid['mermaidAPI']['getDiagramFromText']>) => run(owner, () => mermaid.mermaidAPI.getDiagramFromText(...args)),
    },
  }) as Mermaid['mermaidAPI'];
  return Object.create(mermaid, {
    // Kept until this side's next call; applying it now could change a rendering of the other side.
    initialize: {
      value: (config: MermaidConfig) => {
        configs[owner] = config;
        if (active === owner) active = null;
      },
    },
    render: { value: (...args: Parameters<Mermaid['render']>) => run(owner, () => mermaid.render(...args)) },
    parse: { value: (...args: Parameters<Mermaid['parse']>) => run(owner, () => mermaid.parse(...args)) },
    mermaidAPI: { value: api },
  }) as Mermaid;
}

/** The app's Mermaid (mermaid.ts). */
export const appMermaid = facade('app');

/** Everyone else's: what `import mermaid from 'mermaid'` gets. */
export default facade('other');
