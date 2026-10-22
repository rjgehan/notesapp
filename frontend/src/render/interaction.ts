// Clicks in rendered Markdown (DESIGN §6.7 #6): transcluded notes and other embeds shown in Live
// Preview. Internal links open in the app, tags open search, and a remote-image placeholder loads
// its image. Delegated on the embed's container: the rendered HTML is not React's.
import { openLink, openTag } from '../features/navigation';

export function handleRenderedClick(e: MouseEvent, sourcePath: string): void {
  const target = e.target instanceof Element ? e.target : null;
  if (!target) return;
  const placeholder = target.closest<HTMLElement>('.remote-image-placeholder');
  if (placeholder) {
    const img = document.createElement('img');
    img.src = placeholder.dataset.src ?? '';
    img.alt = placeholder.dataset.alt ?? '';
    if (placeholder.dataset.width) img.width = Number(placeholder.dataset.width);
    placeholder.replaceWith(img);
    return;
  }
  const link = target.closest<HTMLAnchorElement>('a.internal-link');
  if (link) {
    e.preventDefault();
    const href = link.dataset.href ?? '';
    const hash = href.indexOf('#');
    const source = link.closest<HTMLElement>('[data-source]')?.dataset.source ?? sourcePath;
    void openLink(hash < 0 ? href : href.slice(0, hash), hash < 0 ? null : href.slice(hash + 1), source);
    return;
  }
  const tag = target.closest<HTMLAnchorElement>('a.tag');
  if (tag) {
    e.preventDefault();
    openTag(tag.dataset.tag ?? '');
  }
}
