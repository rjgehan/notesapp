// Embed hydration (DESIGN §6.7 #5), run after the rendered HTML is in the document. Media embeds are
// plain elements; embeds whose view descriptor has `loadEmbed` (notes, drawings, PDFs, and later
// sheets) mount a React root. Images are built before insertion (render.ts).
import { QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, type ComponentType } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { queryClient } from '../api/queryClient';
import type { FileEntry } from '../api/types';
import { formatBytes } from '../features/format';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { isMarkdownViewPath, viewFor, type EmbedProps, type FileViewDescriptor } from '../views/registry';

export interface EmbedContext {
  sourcePath: string;
  depth: number;
  entry(path: string): FileEntry | undefined;
  rawUrl(entry: FileEntry, opts?: { download?: boolean }): string;
}

const roots = new WeakMap<Element, Root>();
const lazyEmbeds = new Map<string, ComponentType<EmbedProps>>();

function lazyEmbed(d: FileViewDescriptor): ComponentType<EmbedProps> | null {
  if (!d.loadEmbed) return null;
  let c = lazyEmbeds.get(d.id);
  if (!c) {
    c = lazy(d.loadEmbed);
    lazyEmbeds.set(d.id, c);
  }
  return c;
}

/** A `data-width` or `data-height` value (from `|W` or `|WxH`). */
function size(value: string | undefined): number | undefined {
  const n = Number(value);
  return value && Number.isFinite(n) && n > 0 ? n : undefined;
}

function fileChip(el: HTMLElement, entry: FileEntry, ctx: EmbedContext): void {
  const link = document.createElement('a');
  link.className = 'file-chip';
  link.href = ctx.rawUrl(entry, { download: true });
  link.setAttribute('download', entry.name);
  link.textContent = `${entry.name} · ${formatBytes(entry.size)}`;
  el.appendChild(link);
}

function mountReact(el: HTMLElement, node: React.ReactNode): void {
  // Each mount gets a fresh container, so a re-hydration never reuses one whose root is still
  // being unmounted (roots are unmounted asynchronously).
  const mount = document.createElement('div');
  mount.className = 'embed-root';
  el.appendChild(mount);
  el.setAttribute('data-embed-root', '');
  const root = createRoot(mount);
  roots.set(el, root);
  root.render(
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary label="embed">
        <Suspense fallback={<div className="embed-loading">Loading…</div>}>{node}</Suspense>
      </ErrorBoundary>
    </QueryClientProvider>,
  );
}

/** Hydrates every not-yet-hydrated embed placeholder under `container`. */
export function hydrateEmbeds(container: Element, ctx: EmbedContext): void {
  for (const el of container.querySelectorAll<HTMLElement>('[data-embed-kind]:not([data-hydrated])')) {
    const kind = el.dataset.embedKind;
    if (kind === 'image') continue;
    const entry = ctx.entry(el.dataset.embedPath ?? '');
    el.setAttribute('data-hydrated', '');
    if (!entry) continue;
    const subpath = el.dataset.embedSubpath;
    if (kind === 'audio') {
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'metadata';
      audio.src = ctx.rawUrl(entry);
      el.appendChild(audio);
    } else if (kind === 'video') {
      const video = document.createElement('video');
      video.controls = true;
      video.preload = 'metadata';
      video.setAttribute('playsinline', '');
      video.src = ctx.rawUrl(entry);
      if (el.dataset.width) video.width = Number(el.dataset.width);
      el.appendChild(video);
    } else {
      const descriptor = viewFor(entry);
      const Embed = lazyEmbed(descriptor);
      if (!Embed) {
        fileChip(el, entry, ctx);
        continue;
      }
      // Transclusion is one level deep and never of the note itself (the renderer turns deeper
      // embeds into links; this guards any placeholder that did not come from it). A note another
      // view shows (a drawing) embeds nothing further, so it is embedded at any depth.
      if (entry.kind === 'note' && isMarkdownViewPath(entry.path) && (ctx.depth >= 1 || entry.path === ctx.sourcePath)) continue;
      mountReact(
        el,
        <Embed
          path={entry.path}
          entry={entry}
          subpath={subpath}
          display={el.dataset.embedAlt}
          width={size(el.dataset.width)}
          height={size(el.dataset.height)}
          sourcePath={ctx.sourcePath}
          depth={ctx.depth + 1}
        />,
      );
    }
  }
}

/**
 * Unmounts the React roots of hydrated embeds inside `node` and resets their placeholders, so a
 * later `hydrateEmbeds` can mount them again (React StrictMode runs effect cleanups twice).
 */
export function unmountEmbeds(node: Node): void {
  if (!(node instanceof Element)) return;
  const targets = node.matches('[data-embed-root]') ? [node] : [];
  targets.push(...node.querySelectorAll('[data-embed-root]'));
  for (const el of targets) {
    const root = roots.get(el);
    if (!root) continue;
    roots.delete(el);
    el.querySelector(':scope > .embed-root')?.remove();
    el.removeAttribute('data-embed-root');
    el.removeAttribute('data-hydrated');
    // Unmounting synchronously during a render or commit of the outer tree is not allowed.
    queueMicrotask(() => root.unmount());
  }
}
