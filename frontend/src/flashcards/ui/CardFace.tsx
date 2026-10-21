// One side of a card, rendered like the reading view (DESIGN §6.7): links, tags, images and
// embeds work, and links open their note.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useTree, useVaultSettings } from '../../api/hooks';
import { openLink, openTag } from '../../features/navigation';
import { makeEmbedContext, makeRenderContext } from '../../render/context';
import { hydrateEmbeds, unmountEmbeds } from '../../render/embeds';
import { patchChildren } from '../../render/patch';
import { renderNote } from '../../render/render';
import { usePrefs } from '../../state/prefs';

export function CardFace({ markdown, path, className }: { markdown: string; path: string; className?: string }) {
  const tree = useTree().data;
  const settings = useVaultSettings();
  const loadRemoteImages = usePrefs((s) => s.loadRemoteImages);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tree) return;
    // Depth 1: a note embedded in a card shows as a link, as in a transclusion.
    const { fragment } = renderNote(markdown, makeRenderContext(path, tree, settings, loadRemoteImages, 1));
    patchChildren(el, fragment, unmountEmbeds);
    hydrateEmbeds(el, makeEmbedContext(path, tree, 1));
  }, [markdown, path, tree, settings, loadRemoteImages]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const click = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const link = target.closest<HTMLAnchorElement>('a.internal-link');
      if (link) {
        e.preventDefault();
        e.stopPropagation();
        const href = link.dataset.href ?? '';
        const hash = href.indexOf('#');
        void openLink(hash < 0 ? href : href.slice(0, hash), hash < 0 ? null : href.slice(hash + 1), path);
        return;
      }
      const tag = target.closest<HTMLAnchorElement>('a.tag');
      if (tag) {
        e.preventDefault();
        e.stopPropagation();
        openTag(tag.dataset.tag ?? '');
        return;
      }
      // Other links (web pages) and media controls do their own thing, without flipping the card.
      if (target.closest('a, audio, video, iframe, input, button')) e.stopPropagation();
    };
    el.addEventListener('click', click);
    return () => el.removeEventListener('click', click);
  }, [path]);

  return <div ref={ref} className={`markdown-rendered fc-face${className ? ' ' + className : ''}`} data-source={path} />;
}
