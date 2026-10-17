// Note transclusion (`![[Note]]`, `![[Note#Heading]]`): the rendered note or one heading's section,
// one level deep. Nested note embeds render as links, which also breaks cycles.
import { FileText } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { useTextFile, useTree, useVaultSettings } from '../api/hooks';
import { toLf } from '../features/eol';
import { displayName, noteRoute } from '../features/paths';
import { usePrefs } from '../state/prefs';
import type { EmbedProps } from '../views/registry';
import { makeEmbedContext, makeRenderContext } from './context';
import { hydrateEmbeds, unmountEmbeds } from './embeds';
import { patchChildren } from './patch';
import { extractSection, renderNote } from './render';

export default function NoteEmbed({ path, subpath, sourcePath, depth }: EmbedProps) {
  const file = useTextFile(path);
  const tree = useTree().data;
  const settings = useVaultSettings();
  const loadRemoteImages = usePrefs((s) => s.loadRemoteImages);
  const body = useRef<HTMLDivElement>(null);
  const title = displayName(path) + (subpath ? ` › ${subpath}` : '');

  const text = file.data ? toLf(file.data.content) : null;
  const section = text !== null && subpath ? extractSection(text, subpath) : text;

  useLayoutEffect(() => {
    const el = body.current;
    if (!el || section === null || !tree) return;
    const { fragment } = renderNote(section, makeRenderContext(path, tree, settings, loadRemoteImages, depth));
    patchChildren(el, fragment, unmountEmbeds);
    hydrateEmbeds(el, makeEmbedContext(path, tree, depth));
  }, [section, tree, settings, loadRemoteImages, path, depth]);

  return (
    <div className="markdown-embed" data-source={path} data-embedded-in={sourcePath}>
      <a className="markdown-embed-title internal-link" data-href={path} href={noteRoute(path, subpath)}>
        <FileText size={14} aria-hidden />
        <span>{title}</span>
      </a>
      {file.isError ? (
        <div className="markdown-embed-empty">Could not load this note.</div>
      ) : section === null && text !== null ? (
        <div className="markdown-embed-empty">Heading not found.</div>
      ) : (
        <div ref={body} className="markdown-embed-content markdown-rendered" />
      )}
    </div>
  );
}
