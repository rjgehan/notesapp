// What Live Preview's embeds and properties block show (DESIGN §6.6.1, ROADMAP 10b): the same
// elements the reading of a note always showed (§6.7 #5, #7), built with DOM calls and hydrated by
// embeds.tsx, so an image, a PDF or a transcluded note looks the same in Live Preview, locked or
// not. The editor reaches these through `NoteContext.renderEmbed` and `renderProperties`, so its
// modules import no React.
import { QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { api } from '../api/endpoints';
import { currentTree } from '../api/hooks';
import { queryClient } from '../api/queryClient';
import type { EmbedRequest } from '../editor/context';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { PropertiesTable } from '../views/markdown/PropertiesTable';
import { makeEmbedContext } from './context';
import { hydrateEmbeds, unmountEmbeds } from './embeds';
import { handleRenderedClick } from './interaction';

const KINDS = new Set(['image', 'audio', 'video', 'pdf', 'note']);

/** Shows a vault file's embed in `el`; returns what removes it. */
export function renderLiveEmbed(el: HTMLElement, { entry, subpath, display, size }: EmbedRequest, sourcePath: string): () => void {
  const kind = KINDS.has(entry.kind) ? entry.kind : 'file';
  el.classList.add('markdown-rendered');
  const embed = document.createElement('span');
  embed.className = `internal-embed ${kind}-embed`;
  embed.dataset.embedKind = kind;
  embed.dataset.embedPath = entry.path;
  if (subpath) embed.dataset.embedSubpath = subpath;
  if (size) {
    embed.dataset.width = String(size.width);
    if (size.height !== null) embed.dataset.height = String(size.height);
  } else if (display) {
    embed.dataset.embedAlt = display;
  }
  el.appendChild(embed);
  if (kind === 'image') {
    const img = document.createElement('img');
    img.src = api.rawUrl(entry);
    img.alt = display ?? entry.basename;
    img.loading = 'lazy';
    img.decoding = 'async';
    if (size) {
      img.width = size.width;
      if (size.height !== null) {
        // An explicit WxH keeps its box; the image is letterboxed rather than distorted.
        img.height = size.height;
        img.style.height = `${size.height}px`;
        img.style.objectFit = 'contain';
      }
    } else {
      embed.classList.add('is-reserving');
    }
    embed.appendChild(img);
    return () => embed.remove();
  }
  hydrateEmbeds(el, makeEmbedContext(sourcePath, currentTree(), 0));
  const onClick = (e: MouseEvent) => handleRenderedClick(e, sourcePath);
  el.addEventListener('click', onClick);
  return () => {
    el.removeEventListener('click', onClick);
    unmountEmbeds(el);
  };
}

/** Shows the note's properties in `el`, with an edit button when `onEdit` is given; returns what removes them. */
export function renderLiveProperties(el: HTMLElement, yaml: string, onEdit: (() => void) | null, sourcePath: string): () => void {
  const root = createRoot(el);
  root.render(
    <QueryClientProvider client={queryClient}>
      <ErrorBoundary label="properties">
        <PropertiesTable yaml={yaml} sourcePath={sourcePath} onEdit={onEdit} />
      </ErrorBoundary>
    </QueryClientProvider>,
  );
  // Unmounting synchronously during the editor's update (a widget is destroyed) is not allowed.
  return () => queueMicrotask(() => root.unmount());
}
