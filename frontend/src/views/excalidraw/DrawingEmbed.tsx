// `![[Diagram.excalidraw]]` and `![[Diagram.excalidraw|400]]` (ROADMAP item 5, DESIGN §6.8.1): the
// drawing's `loadEmbed`, so the reading view (and any view that hydrates embeds) shows it as an
// SVG image, exported with Excalidraw's exportToSvg in this lazy chunk. It follows the file (the
// `['file', path]` query that live sync refreshes) and the theme; a click opens the editor.
import { Shapes } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTextFile } from '../../api/hooks';
import { toLf } from '../../features/eol';
import { displayName, noteRoute } from '../../features/paths';
import type { EmbedProps } from '../registry';
import { imageEnv } from './env';
import { DARK_FILTER, renderDrawingSvg } from './svg';
import { useAppTheme } from './theme';

type Shown =
  | { kind: 'loading' }
  | { kind: 'svg'; url: string; width: number; height: number }
  | { kind: 'empty' }
  | { kind: 'unreadable'; message: string }
  | { kind: 'error'; message: string };

const env = imageEnv(0);

export default function DrawingEmbed({ path, display, width, height }: EmbedProps) {
  const file = useTextFile(path);
  const theme = useAppTheme();
  const text = file.data ? toLf(file.data.content) : null;
  const [shown, setShown] = useState<Shown>({ kind: 'loading' });

  useEffect(() => {
    if (text === null) return;
    let cancelled = false;
    renderDrawingSvg(path, text, { dark: theme === 'dark', env }).then(
      (r) => {
        if (cancelled) return;
        setShown(r.kind === 'svg' ? { kind: 'svg', url: URL.createObjectURL(new Blob([r.svg], { type: 'image/svg+xml' })), width: r.width, height: r.height } : r);
      },
      (e: unknown) => {
        if (!cancelled) setShown({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, text, theme]);

  // An image's URL is released once its successor is shown (or the embed goes away).
  useEffect(() => {
    if (shown.kind !== 'svg') return;
    const { url } = shown;
    return () => URL.revokeObjectURL(url);
  }, [shown]);

  const name = displayName(path);
  let status: string | null = null;
  if (shown.kind === 'loading') status = file.isError ? 'Could not load this drawing.' : 'Loading drawing…';
  else if (shown.kind === 'empty') status = `${name} is empty.`;
  else if (shown.kind === 'unreadable') status = `${name} could not be read as a drawing.`;
  else if (shown.kind === 'error') status = `${name} could not be shown.`;

  return (
    <a className="internal-link drawing-embed" data-href={path} href={noteRoute(path)} title={`Open ${name}`}>
      {shown.kind === 'svg' ? (
        <img
          src={shown.url}
          alt={display ?? name}
          width={width ?? (Math.round(shown.width) || undefined)}
          height={width !== undefined ? height : undefined}
          className={height !== undefined && width !== undefined ? 'is-fixed' : undefined}
          style={theme === 'dark' ? { filter: DARK_FILTER } : undefined}
          draggable={false}
        />
      ) : (
        <span className="drawing-embed-status" style={width !== undefined ? { width } : undefined}>
          <Shapes size={16} aria-hidden />
          <span>{status}</span>
        </span>
      )}
    </a>
  );
}
