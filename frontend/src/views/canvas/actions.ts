// Canvas actions that reach outside the document: uploads, new notes, opening files and links,
// prompts. Pure document edits live in ops.ts and the controller.
import { api } from '../../api/endpoints';
import { currentSettings, currentTree } from '../../api/hooks';
import { queryClient } from '../../api/queryClient';
import type { FileEntry } from '../../api/types';
import { findFileIgnoreCase } from '../../api/vaultTree';
import { attachmentName } from '../../features/attachments';
import { toastError } from '../../features/errors';
import { newNoteFolder, validateNewName } from '../../features/fileOps';
import { openPath, openTag, openLink } from '../../features/navigation';
import { joinPath } from '../../features/paths';
import { newIdempotencyKey } from '../../state/clientId';
import { promptText } from '../../state/dialogs';
import { toast } from '../../state/toasts';
import { applyAttachmentResult } from '../../sync/applyEvents';
import { syncTarget } from '../../sync/liveSync';
import { applyWriteResult } from '../../sync/treePatch';
import { toggleTaskAtLine } from '../../render/render';
import type { CanvasController } from './controller';
import { nodeRect, nodeText, str, type CanvasNode, type Point } from './model';
import { DEFAULT_SIZES } from './ops';

/** The size a file node gets: an image's own proportions, at most 400 wide. */
export async function fileNodeSize(entry: FileEntry): Promise<{ width: number; height: number }> {
  if (entry.kind === 'image') {
    const natural = await new Promise<{ width: number; height: number } | null>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = api.rawUrl(entry);
    });
    if (natural && natural.width > 0 && natural.height > 0) {
      const width = Math.min(400, natural.width);
      return { width: Math.round(width), height: Math.round((width * natural.height) / natural.width) };
    }
    return DEFAULT_SIZES.image;
  }
  if (entry.kind === 'note' || entry.path.toLowerCase().endsWith('.canvas')) return DEFAULT_SIZES.file;
  if (entry.kind === 'audio') return { width: 400, height: 100 };
  if (entry.kind === 'video') return { width: 400, height: 260 };
  return { width: 300, height: 160 };
}

/** Adds file nodes for vault files, laid out left to right from `at` (their centre row). */
export async function addFileNodes(controller: CanvasController, entries: FileEntry[], at: Point): Promise<void> {
  const sizes = await Promise.all(entries.map(fileNodeSize));
  let x = at.x - (sizes.reduce((s, z) => s + z.width, 0) + 20 * (sizes.length - 1)) / 2;
  const nodes = entries.map((entry, i) => {
    const s = sizes[i];
    const node = { type: 'file', file: entry.path, x: Math.round(x), y: Math.round(at.y - s.height / 2), width: s.width, height: s.height };
    x += s.width + 20;
    return node;
  });
  controller.addNodesAt(nodes);
}

/** Uploads files as attachments of the canvas and adds them as file nodes at `at`. */
export async function uploadAndAdd(controller: CanvasController, files: readonly File[], at: Point, pasted: boolean): Promise<void> {
  if (files.length === 0 || controller.getState().readOnly) return;
  const now = new Date();
  const uploaded: FileEntry[] = [];
  for (const file of files) {
    const name = attachmentName(file, pasted, now);
    try {
      const result = await api.uploadAttachment(name, controller.path, file, { idempotencyKey: newIdempotencyKey() });
      applyAttachmentResult(syncTarget, result);
      uploaded.push(result.file);
    } catch (e) {
      toastError(e, name);
    }
  }
  if (uploaded.length) await addFileNodes(controller, uploaded, at);
}

/**
 * Uploads files pasted, dropped or picked into a card's editor as attachments of the canvas, and
 * returns their embeds (`![[name.png]]`), linked as seen from the canvas.
 */
export async function uploadForCard(canvasPath: string, files: readonly File[], pasted: boolean): Promise<string[]> {
  const now = new Date();
  const embeds: string[] = [];
  for (const file of files) {
    const name = attachmentName(file, pasted, now);
    try {
      const result = await api.uploadAttachment(name, canvasPath, file, { idempotencyKey: newIdempotencyKey() });
      applyAttachmentResult(syncTarget, result);
      embeds.push(result.markdown);
    } catch (e) {
      toastError(e, name);
    }
  }
  return embeds;
}

/** A name for a note made from a card: its first line, without Markdown or characters names cannot hold. */
export function noteNameFromText(text: string): string {
  const first = text
    .split('\n')
    .map((l) => l.replace(/^#{1,6}\s+/, '').replace(/[*_`~=[\]#^|\\/:"<>?]/g, '').trim())
    .find((l) => l !== '');
  return (first ?? 'Untitled').slice(0, 60).trim() || 'Untitled';
}

/**
 * "Convert to note": the card's text becomes a new note (in the new-note folder), and the card a
 * file node showing it, in the same place.
 */
export async function convertToNote(controller: CanvasController, nodeId: string): Promise<void> {
  const node = controller.doc?.nodes.find((n) => n.id === nodeId);
  if (!node || node.type !== 'text') return;
  const text = nodeText(node);
  const name = await promptText({
    title: 'Convert card to note',
    label: 'Note name',
    value: noteNameFromText(text),
    confirmLabel: 'Create note',
    validate: (v) => (v.trim() === '' ? 'A name is required' : validateNewName(`${v.trim()}.md`)),
  });
  if (!name) return;
  const folder = newNoteFolder(controller.path, currentSettings());
  try {
    const result = await api.createFile({ path: joinPath(folder, `${name.trim()}.md`), content: text, onConflict: 'rename' }, { idempotencyKey: newIdempotencyKey() });
    applyWriteResult(queryClient, result, text);
    const current = controller.doc?.nodes.find((n) => n.id === nodeId);
    if (!current) return;
    // A file node in Obsidian's field order, keeping the card's place, size, colour and unknown fields.
    const { id, type: _type, text: _text, x: _x, y: _y, width: _w, height: _h, ...rest } = current;
    const r = nodeRect(current);
    controller.replaceNode(nodeId, { id, type: 'file', file: result.file.path, x: r.x, y: r.y, width: r.width, height: r.height, ...rest });
    toast(`Created “${result.file.basename}”`);
  } catch (e) {
    toastError(e);
  }
}

export function openFileNode(node: CanvasNode): void {
  const file = str(node.file);
  if (!file) return;
  const entry = findFileIgnoreCase(currentTree(), file);
  if (!entry) {
    toast(`“${file}” is not in the vault`, { kind: 'error' });
    return;
  }
  const subpath = str(node.subpath)?.replace(/^#/, '') ?? null;
  openPath(entry.path, subpath || null);
}

export function openLinkNode(node: CanvasNode): void {
  const url = str(node.url);
  if (url && /^https?:\/\//i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
}

/** Asks for a web address and adds a link node at `at`. */
export async function promptLink(controller: CanvasController, at: Point): Promise<void> {
  const url = await promptText({
    title: 'Add web page',
    label: 'Address',
    value: 'https://',
    confirmLabel: 'Add',
    validate: (v) => (/^https?:\/\/\S+$/i.test(v.trim()) ? null : 'Enter an address starting with https://'),
  });
  if (!url) return;
  const s = DEFAULT_SIZES.link;
  controller.addNode({ type: 'link', url: url.trim(), x: Math.round(at.x - s.width / 2), y: Math.round(at.y - s.height / 2), width: s.width, height: s.height });
}

export async function promptEdgeLabel(controller: CanvasController, edgeId: string): Promise<void> {
  const edge = controller.doc?.edges.find((e) => e.id === edgeId);
  if (!edge || controller.getState().readOnly) return;
  const label = await promptText({ title: 'Edge label', label: 'Label', value: str(edge.label) ?? '', confirmLabel: 'Save', validate: () => null });
  if (label === null) return;
  controller.updateEdge(edgeId, { label: label.trim() === '' ? undefined : label });
}

export async function promptGroupLabel(controller: CanvasController, nodeId: string): Promise<void> {
  const node = controller.doc?.nodes.find((n) => n.id === nodeId);
  if (!node || controller.getState().readOnly) return;
  const label = await promptText({ title: 'Group name', label: 'Name', value: str(node.label) ?? '', confirmLabel: 'Save', validate: () => null });
  if (label === null) return;
  controller.updateNode(nodeId, { label: label.trim() === '' ? undefined : label });
}

/**
 * A tap on something that acts by itself inside a card: an internal link (resolved from the note
 * or canvas it is in), a tag, an external link, a task checkbox (toggles the card's line), or a
 * file node's name. True when handled.
 */
export function activateInCard(controller: CanvasController, target: Element, nodeId: string): boolean {
  const node = controller.doc?.nodes.find((n) => n.id === nodeId);
  if (!node) return false;
  if (target.closest('[data-open-file]')) {
    openFileNode(node);
    return true;
  }
  const placeholder = target.closest<HTMLElement>('.remote-image-placeholder');
  if (placeholder) {
    const img = document.createElement('img');
    img.src = placeholder.dataset.src ?? '';
    img.alt = placeholder.dataset.alt ?? '';
    if (placeholder.dataset.width) img.width = Number(placeholder.dataset.width);
    placeholder.replaceWith(img);
    return true;
  }
  const internal = target.closest<HTMLAnchorElement>('a.internal-link');
  if (internal) {
    const href = internal.dataset.href ?? '';
    const hash = href.indexOf('#');
    const source = internal.closest<HTMLElement>('[data-source]')?.dataset.source ?? controller.path;
    void openLink(hash < 0 ? href : href.slice(0, hash), hash < 0 ? null : href.slice(hash + 1), source);
    return true;
  }
  const tag = target.closest<HTMLAnchorElement>('a.tag');
  if (tag) {
    openTag(tag.dataset.tag ?? '');
    return true;
  }
  const external = target.closest<HTMLAnchorElement>('a[href]');
  if (external && /^(https?|mailto):/i.test(external.href)) {
    window.open(external.href, '_blank', 'noopener,noreferrer');
    return true;
  }
  const box = target.closest<HTMLInputElement>('input.task-list-item-checkbox');
  if (box && node.type === 'text' && !box.closest('[data-embed-root]')) {
    if (controller.getState().readOnly) return true;
    const change = toggleTaskAtLine(nodeText(node), Number(box.dataset.line), box.dataset.hash ?? '');
    if (change) {
      const text = nodeText(node);
      controller.updateNode(nodeId, { text: text.slice(0, change.from) + change.insert + text.slice(change.to) });
    }
    return true;
  }
  return false;
}

