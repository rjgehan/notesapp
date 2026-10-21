// One canvas node: a Markdown card, a file (a note rendered like an embed, an image, media, a
// nested canvas, or a file chip), a web link, or a group. Positioned in world coordinates inside
// the transformed world layer; memoized, so a node re-renders only when its own data, geometry or
// selection changes.
import { File, FileQuestionMark, Globe, LayoutDashboard } from 'lucide-react';
import { lazy, memo, Suspense, useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';
import { api } from '../../api/endpoints';
import { useTextFile } from '../../api/hooks';
import type { FileEntry, Settings } from '../../api/types';
import { findFileIgnoreCase, type VaultTree } from '../../api/vaultTree';
import { toLf } from '../../features/eol';
import { formatBytes } from '../../features/format';
import { resolve } from '../../features/links';
import { displayName, lastSegment } from '../../features/paths';
import { makeEmbedContext, makeRenderContext } from '../../render/context';
import { hydrateEmbeds, unmountEmbeds } from '../../render/embeds';
import { patchChildren } from '../../render/patch';
import { extractSection, renderNote } from '../../render/render';
import { CardEditor } from './CardEditor';
import type { CanvasController } from './controller';
import { cssColor, nodeText, plainExcerpt, str, type CanvasNode, type CanvasSide, type Rect } from './model';

const CanvasPreview = lazy(() => import('./CanvasEmbed'));

export type Lod = 'full' | 'low';

/** What every card needs from the app, read once by the view (one subscription for all cards). */
export interface RenderEnv {
  tree: VaultTree;
  settings: Settings;
  loadRemoteImages: boolean;
  canvasPath: string;
}

interface Props {
  node: CanvasNode;
  rect: Rect;
  selected: boolean;
  editing: boolean;
  /** Draws the resize handles and connection points (one selected node, editable canvas). */
  handles: boolean;
  /** Shows the connection points (hover or selection). */
  connectable: boolean;
  /** The node an edge being drawn would connect to. */
  target: boolean;
  lod: Lod;
  env: RenderEnv;
  controller: CanvasController;
}

const SIDES: CanvasSide[] = ['top', 'right', 'bottom', 'left'];
const HANDLES = ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'] as const;

/** The vault file a file node points at (its path as written, or the same path in another case). */
function fileEntryOf(node: CanvasNode, tree: VaultTree): FileEntry | undefined {
  const file = str(node.file);
  return file ? findFileIgnoreCase(tree, file) : undefined;
}

export const NodeView = memo(function NodeView({ node, rect, selected, editing, handles, connectable, target, lod, env, controller }: Props) {
  const color = cssColor(node.color);
  const type = node.type;
  const style: CSSProperties & Record<string, string | number> = {
    left: rect.x,
    top: rect.y,
    width: rect.width,
    height: rect.height,
  };
  if (color) style['--canvas-color'] = color;
  const className = [
    'canvas-node',
    `is-${['text', 'file', 'link', 'group'].includes(type) ? type : 'unknown'}`,
    color ? 'has-color' : '',
    selected ? 'is-selected' : '',
    editing ? 'is-editing' : '',
    target ? 'is-target' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={className} style={style} data-node-id={node.id}>
      {type === 'group' ? (
        <GroupBox node={node} env={env} />
      ) : (
        <>
          {type === 'file' && <FileLabel node={node} />}
          <div className="canvas-node-container">
            <NodeContent node={node} editing={editing} lod={lod} env={env} controller={controller} />
          </div>
        </>
      )}
      {handles && HANDLES.map((h) => <div key={h} className={`canvas-resize is-${h}`} data-handle={h} aria-hidden />)}
      {(handles || connectable) && !editing &&
        SIDES.map((s) => <div key={s} className={`canvas-connect is-${s}`} data-connect={s} aria-label={`Connect from the ${s}`} />)}
    </div>
  );
});

function NodeContent({ node, editing, lod, env, controller }: { node: CanvasNode; editing: boolean; lod: Lod; env: RenderEnv; controller: CanvasController }) {
  switch (node.type) {
    case 'text': {
      const text = nodeText(node);
      if (editing) {
        return (
          <CardEditor
            text={text}
            canvasPath={env.canvasPath}
            onChange={(t) => controller.setNodeText(node.id, t)}
            onDone={() => controller.stopEditing()}
            onSave={() => controller.save()}
            onBlur={() => controller.writeNow()}
          />
        );
      }
      if (lod === 'low') return <div className="canvas-node-plain">{plainExcerpt(text)}</div>;
      return <MarkdownCard text={text} env={env} />;
    }
    case 'file':
      return <FileCard node={node} lod={lod} env={env} controller={controller} />;
    case 'link':
      return <LinkCard node={node} />;
    default:
      return (
        <div className="canvas-node-plain is-muted">
          <FileQuestionMark size={16} aria-hidden /> {`A “${String(node.type)}” node`}
        </div>
      );
  }
}

function MarkdownCard({ text, env }: { text: string; env: RenderEnv }) {
  const ref = useRef<HTMLDivElement>(null);
  const { tree, settings, loadRemoteImages, canvasPath } = env;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { fragment } = renderNote(text, makeRenderContext(canvasPath, tree, settings, loadRemoteImages, 0));
    patchChildren(el, fragment, unmountEmbeds);
    hydrateEmbeds(el, makeEmbedContext(canvasPath, tree, 0));
  }, [text, tree, settings, loadRemoteImages, canvasPath]);

  useEffect(() => {
    const el = ref.current;
    return () => {
      if (el) for (const child of [...el.childNodes]) unmountEmbeds(child);
    };
  }, []);

  return <div ref={ref} className="markdown-rendered canvas-markdown" data-source={canvasPath} />;
}

function FileLabel({ node }: { node: CanvasNode }) {
  const file = str(node.file) ?? '';
  const subpath = str(node.subpath);
  return (
    <div className="canvas-node-label is-file" data-open-file>
      {displayName(file)}
      {subpath ? <span className="canvas-node-label-sub">{subpath}</span> : null}
    </div>
  );
}

function FileCard({ node, lod, env, controller }: { node: CanvasNode; lod: Lod; env: RenderEnv; controller: CanvasController }) {
  const file = str(node.file) ?? '';
  const entry = fileEntryOf(node, env.tree);
  if (!entry) {
    // Moved or renamed elsewhere? A file of the same name is offered (moves do not rewrite canvases).
    const candidate = file ? resolve(lastSegment(file), env.canvasPath, env.tree.links) : null;
    return (
      <div className="canvas-file-missing">
        <FileQuestionMark size={20} aria-hidden />
        <span>{file ? `“${file}” is not in the vault` : 'No file chosen'}</span>
        {candidate && candidate !== env.canvasPath && lod === 'full' && !controller.getState().readOnly && (
          <button type="button" className="button button-small canvas-ui" onClick={() => controller.updateNode(node.id, { file: candidate })}>
            Use {candidate}
          </button>
        )}
      </div>
    );
  }
  if (entry.kind === 'image') {
    return <img className="canvas-image" src={api.rawUrl(entry)} alt={entry.name} draggable={false} loading="lazy" />;
  }
  if (lod === 'low') {
    return (
      <div className="canvas-node-plain">
        <File size={16} aria-hidden /> {displayName(entry.path)}
      </div>
    );
  }
  if (entry.kind === 'note') return <NoteBody path={entry.path} subpath={str(node.subpath)} env={env} />;
  if (entry.kind === 'audio') return <audio className="canvas-media" controls preload="metadata" src={api.rawUrl(entry)} />;
  if (entry.kind === 'video') return <video className="canvas-media" controls playsInline preload="metadata" src={api.rawUrl(entry)} />;
  if (entry.path.toLowerCase().endsWith('.canvas') && entry.path !== env.canvasPath) {
    return (
      <Suspense fallback={null}>
        <CanvasPreview path={entry.path} entry={entry} sourcePath={env.canvasPath} depth={1} bare />
      </Suspense>
    );
  }
  return (
    <div className="canvas-file-chip">
      {entry.path.toLowerCase().endsWith('.canvas') ? <LayoutDashboard size={28} aria-hidden /> : <File size={28} aria-hidden />}
      <span className="canvas-file-chip-name">{lastSegment(entry.path)}</span>
      <span className="canvas-file-chip-size">{formatBytes(entry.size)}</span>
    </div>
  );
}

/** A note in a file node: rendered like a transclusion (its nested note embeds become links). */
function NoteBody({ path, subpath, env }: { path: string; subpath?: string; env: RenderEnv }) {
  const file = useTextFile(path);
  const ref = useRef<HTMLDivElement>(null);
  const text = file.data ? toLf(file.data.content) : null;
  const section = text !== null && subpath ? extractSection(text, subpath.replace(/^#/, '')) : text;
  const { tree, settings, loadRemoteImages } = env;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || section === null) return;
    const { fragment } = renderNote(section, makeRenderContext(path, tree, settings, loadRemoteImages, 1));
    patchChildren(el, fragment, unmountEmbeds);
    hydrateEmbeds(el, makeEmbedContext(path, tree, 1));
  }, [section, tree, settings, loadRemoteImages, path]);

  useEffect(() => {
    const el = ref.current;
    return () => {
      if (el) for (const child of [...el.childNodes]) unmountEmbeds(child);
    };
  }, []);

  if (file.isError) return <div className="canvas-node-plain is-muted">Could not load this note.</div>;
  if (text !== null && section === null) return <div className="canvas-node-plain is-muted">Heading not found.</div>;
  return <div ref={ref} className="markdown-rendered canvas-markdown" data-source={path} />;
}

function LinkCard({ node }: { node: CanvasNode }) {
  const url = str(node.url) ?? '';
  let host = url;
  try {
    host = new URL(url).host || url;
  } catch {
    // Not a URL; shown as written.
  }
  const safe = /^https?:\/\//i.test(url);
  return (
    <div className="canvas-link-card">
      <div className="canvas-link-host">
        <Globe size={16} aria-hidden /> <span>{host}</span>
      </div>
      <div className="canvas-link-url">{url}</div>
      {safe && (
        <a className="button button-small canvas-link-open" href={url} target="_blank" rel="noopener noreferrer" data-external-link>
          Open
        </a>
      )}
    </div>
  );
}

function GroupBox({ node, env }: { node: CanvasNode; env: RenderEnv }) {
  const label = str(node.label);
  const background = str(node.background);
  const entry = background ? findFileIgnoreCase(env.tree, background) : undefined;
  const style: CSSProperties = {};
  if (entry && entry.kind === 'image') {
    style.backgroundImage = `url("${api.rawUrl(entry)}")`;
    const mode = str(node.backgroundStyle);
    style.backgroundSize = mode === 'ratio' ? 'contain' : mode === 'repeat' ? 'auto' : 'cover';
    style.backgroundRepeat = mode === 'repeat' ? 'repeat' : 'no-repeat';
    style.backgroundPosition = 'center';
  }
  return (
    <>
      {label !== undefined && label !== '' && (
        <div className="canvas-node-label is-group" data-group-label>
          {label}
        </div>
      )}
      <div className="canvas-group-box" style={style} />
    </>
  );
}
