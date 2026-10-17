// The app services a drawing uses (DrawingEnv): attachments through the vault's own endpoints,
// links through the client resolver, errors as toasts.
import { api } from '../../api/endpoints';
import { currentSettings, currentTree } from '../../api/hooks';
import { attachmentName } from '../../features/attachments';
import { linkText, resolve } from '../../features/links';
import { lastSegment } from '../../features/paths';
import { newIdempotencyKey } from '../../state/clientId';
import { toast } from '../../state/toasts';
import { applyAttachmentResult } from '../../sync/applyEvents';
import { syncTarget } from '../../sync/liveSync';
import type { DrawingEnv } from './controller';
import { displayDataUrl, isPastedName } from './files';

/** An attachment's tree entry: its exact path, else the link resolution notes use (it may have moved). */
function findAttachment(path: string, source: string) {
  const tree = currentTree();
  const exact = tree.byPath.get(path);
  if (exact) return exact;
  const resolved = resolve(path, source, tree.links) ?? resolve(lastSegment(path), source, tree.links);
  return resolved ? tree.byPath.get(resolved) : undefined;
}

export const drawingEnv: DrawingEnv = {
  async loadAttachment(path, source) {
    const entry = findAttachment(path, source);
    if (!entry) return null;
    const response = await fetch(api.rawUrl(entry));
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return { ...(await displayDataUrl(await response.blob())), path: entry.path };
  },
  resolveLink: (target, source) => resolve(target, source, currentTree().links),
  async upload(blob, name, source) {
    const fileName = name && !isPastedName(name) ? name : attachmentName({ name: '', type: blob.type }, true);
    const result = await api.uploadAttachment(fileName, source, blob, { idempotencyKey: newIdempotencyKey() });
    applyAttachmentResult(syncTarget, result);
    return { path: result.file.path };
  },
  linkText: (path, source) => linkText(path, source, currentSettings().files.newLinkFormat, 'wiki', currentTree().links),
  reportError: (message) => toast(message, { kind: 'error' }),
};
