import { api } from '../api/endpoints';
import type { Settings } from '../api/types';
import type { VaultTree } from '../api/vaultTree';
import { resolve } from '../features/links';
import type { EmbedContext } from './embeds';
import type { RenderContext } from './render';

/** Render context over the current tree, settings and per-device preferences. */
export function makeRenderContext(sourcePath: string, tree: VaultTree, settings: Settings, loadRemoteImages: boolean, depth = 0): RenderContext {
  return {
    sourcePath,
    resolve: (target) => {
      const path = resolve(target, sourcePath, tree.links);
      return path ? (tree.byPath.get(path) ?? null) : null;
    },
    rawUrl: (entry) => api.rawUrl(entry),
    strictLineBreaks: settings.editor.strictLineBreaks,
    loadRemoteImages,
    depth,
  };
}

export function makeEmbedContext(sourcePath: string, tree: VaultTree, depth = 0): EmbedContext {
  return {
    sourcePath,
    depth,
    entry: (path) => tree.byPath.get(path),
    rawUrl: (entry, opts) => api.rawUrl(entry, opts),
  };
}
