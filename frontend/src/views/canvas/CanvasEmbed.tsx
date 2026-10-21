// `![[Board.canvas]]` in a note (and a canvas shown inside another canvas's file node): a static,
// scaled-down picture of the board, its cards as boxes with their first lines. `|W` or `|WxH` sets
// the size (default: the full width, 400 px high). Clicking it opens the canvas.
import { LayoutDashboard } from 'lucide-react';
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '../../api/endpoints';
import { useTextFile, useTree } from '../../api/hooks';
import { findFileIgnoreCase } from '../../api/vaultTree';
import { toLf } from '../../features/eol';
import { displayName, noteRoute } from '../../features/paths';
import type { EmbedProps } from '../registry';
import './canvas.css';
import { EdgeView } from './EdgeView';
import { parseCanvas } from './format';
import { boundsOf, cssColor, nodeRect, nodeText, plainExcerpt, str, type CanvasDoc, type Rect } from './model';

const SIZE = /^(\d+)(?:x(\d+))?$/;
const PAD = 40;

export default function CanvasEmbed({ path, display, bare }: EmbedProps & { bare?: boolean }) {
  const file = useTextFile(path);
  const tree = useTree().data;
  const box = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState({ width: 0, height: 0 });
  const content = file.data ? toLf(file.data.content) : null;
  const doc = useMemo<CanvasDoc | null>(() => {
    if (content === null) return null;
    try {
      return parseCanvas(content);
    } catch {
      return null;
    }
  }, [content]);

  const size = display ? SIZE.exec(display.trim()) : null;
  const fixedWidth = size ? Number(size[1]) : null;
  const height = bare ? null : size?.[2] ? Number(size[2]) : 400;

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setMeasured((m) => (m.width === el.clientWidth && m.height === el.clientHeight ? m : { width: el.clientWidth, height: el.clientHeight }));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const rects = useMemo(() => new Map(doc?.nodes.map((n) => [n.id, nodeRect(n)]) ?? []), [doc]);
  const bounds = useMemo(() => boundsOf([...rects.values()]), [rects]);
  const width = measured.width;
  const boxHeight = height ?? measured.height;
  const scale = bounds && width > 0 && boxHeight > 0 ? Math.min(1, (width - 2 * 8) / (bounds.width + 2 * PAD), (boxHeight - 2 * 8) / (bounds.height + 2 * PAD)) : 0;
  const worldStyle: CSSProperties | undefined =
    bounds && scale > 0
      ? {
          transform: `translate(${width / 2 - (bounds.x + bounds.width / 2) * scale}px, ${boxHeight / 2 - (bounds.y + bounds.height / 2) * scale}px) scale(${scale})`,
          ['--inv-zoom' as string]: String(1 / scale),
        }
      : undefined;

  const body = (
    <div
      ref={box}
      className={`canvas-preview${bare ? ' is-bare' : ''}`}
      style={{ height: height ?? undefined, width: fixedWidth ?? undefined, maxWidth: '100%' }}
      aria-label={`Preview of ${displayName(path)}`}
    >
      {file.isError ? (
        <div className="canvas-preview-empty">Could not load this canvas.</div>
      ) : content !== null && !doc ? (
        <div className="canvas-preview-empty">This canvas could not be read.</div>
      ) : doc && doc.nodes.length === 0 ? (
        <div className="canvas-preview-empty">Empty canvas</div>
      ) : (
        doc &&
        worldStyle && (
          <div className="canvas-world is-low-detail is-preview" style={worldStyle}>
            {doc.nodes
              .filter((n) => n.type === 'group')
              .map((n) => (
                <PreviewNode key={n.id} node={n} rect={rects.get(n.id)!} tree={tree} />
              ))}
            <svg className="canvas-edges" width="1" height="1" aria-hidden>
              {doc.edges.map((e) => (
                <EdgeView key={e.id} edge={e} from={rects.get(e.fromNode)} to={rects.get(e.toNode)} selected={false} />
              ))}
            </svg>
            {doc.nodes
              .filter((n) => n.type !== 'group')
              .map((n) => (
                <PreviewNode key={n.id} node={n} rect={rects.get(n.id)!} tree={tree} />
              ))}
          </div>
        )
      )}
    </div>
  );

  if (bare) return body;
  return (
    <div className="canvas-embed" data-source={path}>
      <a className="markdown-embed-title internal-link" data-href={path} href={noteRoute(path)}>
        <LayoutDashboard size={14} aria-hidden />
        <span>{displayName(path)}</span>
      </a>
      <a className="canvas-embed-open internal-link" href={noteRoute(path)} data-href={path} aria-label={`Open ${displayName(path)}`}>
        {body}
      </a>
    </div>
  );
}

function PreviewNode({ node, rect, tree }: { node: CanvasDoc['nodes'][number]; rect: Rect; tree: ReturnType<typeof useTree>['data'] }) {
  const color = cssColor(node.color);
  const style: CSSProperties & Record<string, string | number> = { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
  if (color) style['--canvas-color'] = color;
  const cls = `canvas-node is-${['text', 'file', 'link', 'group'].includes(node.type) ? node.type : 'unknown'}${color ? ' has-color' : ''}`;
  if (node.type === 'group') {
    const label = str(node.label);
    return (
      <div className={cls} style={style}>
        {label && <div className="canvas-node-label is-group">{label}</div>}
        <div className="canvas-group-box" />
      </div>
    );
  }
  let inner: ReactNode;
  if (node.type === 'text') inner = plainExcerpt(nodeText(node), 300);
  else if (node.type === 'link') inner = str(node.url) ?? '';
  else if (node.type === 'file') {
    const entry = tree ? findFileIgnoreCase(tree, str(node.file) ?? '') : undefined;
    inner = entry?.kind === 'image' ? <img className="canvas-image" src={api.rawUrl(entry)} alt="" loading="lazy" draggable={false} /> : displayName(str(node.file) ?? '');
  } else inner = String(node.type);
  return (
    <div className={cls} style={style}>
      <div className="canvas-node-container">
        <div className="canvas-node-plain">{inner}</div>
      </div>
    </div>
  );
}
