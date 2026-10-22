// An answer from Claude, rendered with the reading-view pipeline (DESIGN §6.7): Markdown with the
// Obsidian rules, sanitized by DOMPurify, wikilinks resolved over the tree. A cited note opens on a
// click; a link the vault cannot resolve (a model's mistake) never creates a note, unlike in a note.
// Remote images stay placeholders whatever the device preference: an answer should fetch nothing.
import { useLayoutEffect, useRef, type MouseEvent } from 'react';
import { useTree, useVaultSettings } from '../../api/hooks';
import { resolve } from '../links';
import { openPath, openTag } from '../navigation';
import { makeRenderContext } from '../../render/context';
import { renderNote } from '../../render/render';
import { toast } from '../../state/toasts';
import { useUi } from '../../state/ui';

interface Props {
  text: string;
  className?: string;
  /** Called after a cited note was opened (the phone's sheet closes). */
  onOpen?(): void;
}

export function AiAnswer({ text, className, onOpen }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const tree = useTree().data;
  const settings = useVaultSettings();

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!tree) {
      el.textContent = text;
      return;
    }
    // Depth 1: note embeds become links, so an answer never transcludes a note.
    const { fragment } = renderNote(text, makeRenderContext('', tree, settings, false, 1));
    el.replaceChildren(fragment);
  }, [text, tree, settings]);

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const link = target.closest<HTMLAnchorElement>('a.internal-link');
    if (link) {
      e.preventDefault();
      const href = link.dataset.href ?? '';
      const hash = href.indexOf('#');
      const linkTarget = hash < 0 ? href : href.slice(0, hash);
      const subpath = hash < 0 ? null : href.slice(hash + 1);
      const path = tree ? resolve(linkTarget, '', tree.links) : null;
      if (!path) {
        toast(`“${linkTarget}” is not a note in this vault`, { kind: 'error' });
        return;
      }
      useUi.getState().setSheetOpen(false);
      openPath(path, subpath);
      onOpen?.();
      return;
    }
    const tag = target.closest<HTMLAnchorElement>('a.tag');
    if (tag) {
      e.preventDefault();
      openTag(tag.dataset.tag ?? '');
    }
  };

  return <div ref={ref} className={`ai-markdown markdown-rendered${className ? ' ' + className : ''}`} onClick={onClick} />;
}
