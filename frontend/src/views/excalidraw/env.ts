// The app services a drawing uses (DrawingEnv, ImageEnv): attachments through the vault's own
// endpoints, links through the client resolver, errors as toasts, and the Obsidian plugin's
// embedded notes and drawings as static images.
import { api } from '../../api/endpoints';
import { currentSettings, currentTree, fetchTextFile } from '../../api/hooks';
import { attachmentName } from '../../features/attachments';
import { toLf } from '../../features/eol';
import { linkText, resolve } from '../../features/links';
import { displayName, lastSegment } from '../../features/paths';
import { extractSection } from '../../render/render';
import { newIdempotencyKey } from '../../state/clientId';
import { toast } from '../../state/toasts';
import { applyAttachmentResult } from '../../sync/applyEvents';
import { syncTarget } from '../../sync/liveSync';
import type { DrawingEnv } from './controller';
import { displayDataUrl, isPastedName } from './files';
import { isDrawingPath } from './format';
import type { ImageEnv } from './images';
import { noteCardSvg, svgDataUrl, type Box } from './statics';
import { renderDrawingSvg } from './svg';

/** A drawing embedded in a drawing is shown; one embedded in that is a placeholder. */
const MAX_NESTING = 1;

/** An attachment's tree entry: its exact path, else the link resolution notes use (it may have moved). */
function findAttachment(path: string, source: string) {
  const tree = currentTree();
  const exact = tree.byPath.get(path);
  if (exact) return exact;
  const resolved = resolve(path, source, tree.links) ?? resolve(lastSegment(path), source, tree.links);
  return resolved ? tree.byPath.get(resolved) : undefined;
}

/** A note (or one heading's section of it) or a drawing, as the static image the plugin's embed shows. */
async function embeddedFile(path: string, subpath: string | null, box: Box | undefined, depth: number) {
  const entry = currentTree().byPath.get(path);
  const drawing = isDrawingPath(path);
  if (!entry || (entry.kind !== 'note' && !drawing) || (drawing && depth >= MAX_NESTING)) return null;
  const text = toLf((await fetchTextFile(path)).content);
  if (drawing) {
    const svg = await renderDrawingSvg(path, text, { dark: false, env: imageEnv(depth + 1) });
    if (svg.kind === 'svg') return { dataURL: svgDataUrl(svg.svg), mimeType: 'image/svg+xml' };
    // An .excalidraw.md without a drawing is a note.
    if (svg.kind === 'empty' || entry.kind !== 'note') return null;
  }
  const section = subpath ? extractSection(text, subpath) : text;
  if (section === null) return null;
  return { dataURL: svgDataUrl(noteCardSvg(displayName(path) + (subpath ? ` › ${subpath}` : ''), section, box)), mimeType: 'image/svg+xml' };
}

/** Images of a drawing shown at `depth`: 0 for the editor and `![[drawing]]` embeds. */
export function imageEnv(depth: number): ImageEnv {
  return {
    async loadAttachment(path, source, opts) {
      const entry = findAttachment(path, source);
      if (!entry) return null;
      const response = await fetch(api.rawUrl(entry));
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return { ...(await displayDataUrl(await response.blob(), opts)), path: entry.path };
    },
    resolveLink: (target, source) => resolve(target, source, currentTree().links),
    embeddedFile: (path, subpath, _source, box) => embeddedFile(path, subpath, box, depth),
  };
}

export const drawingEnv: DrawingEnv = {
  ...imageEnv(0),
  async upload(blob, name, source) {
    const fileName = name && !isPastedName(name) ? name : attachmentName({ name: '', type: blob.type }, true);
    const result = await api.uploadAttachment(fileName, source, blob, { idempotencyKey: newIdempotencyKey() });
    applyAttachmentResult(syncTarget, result);
    return { path: result.file.path };
  },
  linkText: (path, source) => linkText(path, source, currentSettings().files.newLinkFormat, 'wiki', currentTree().links),
  reportError: (message) => toast(message, { kind: 'error' }),
};
