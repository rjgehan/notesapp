// Block references across notes (ROADMAP item 20, DESIGN §6.37): reading a note's blocks for the
// `[[Note#^` picker and the backlinks panel, and giving a block an id when a link to it is made.
import { api } from '../api/endpoints';
import { fetchTextFile } from '../api/hooks';
import { applyBlockIdResult } from '../sync/applyEvents';
import { documents } from '../sync/instance';
import { syncTarget } from '../sync/liveSync';
import { blockIdsIn, newBlockId, noteLines, planBlockId, type NoteBlock } from './blocks';
import { toLf } from './eol';
import { toastError } from './errors';
import type { NoteContext } from '../editor/context';

/** The current text of a note (LF): an open session's buffer when it has one, else the server's. */
export async function readNoteText(path: string): Promise<string> {
  const session = documents.get(path);
  if (session?.showsExistingFile()) return session.getText();
  return toLf((await fetchTextFile(path)).content);
}

/**
 * The id of `block` of the note at `path` (read from `text`), adding one when it has none. A note
 * this tab holds unsaved edits for gets the id as a local edit (saved with them); otherwise the
 * server adds it to the current file (API.md §37), so an edit made elsewhere meanwhile is kept.
 * The new id is `wanted` unless the note has it already.
 */
export async function ensureBlockId(path: string, text: string, block: NoteBlock, wanted?: string): Promise<string> {
  if (block.id) return block.id;
  const lineText = noteLines(text)[block.anchor] ?? '';
  const fields = { line: block.anchor, lineText, placement: block.placement };
  const session = documents.get(path);
  if (session && session.isEditable() && session.hasUnsavedChanges()) {
    const current = session.getText();
    const taken = blockIdsIn(current);
    const id = wanted && !taken.some((t) => t.toLowerCase() === wanted.toLowerCase()) ? wanted : newBlockId(taken);
    const plan = planBlockId(current, fields, id);
    if (plan.kind === 'missing') throw new Error('The block changed meanwhile; pick it again.');
    if (plan.kind === 'insert') session.applyEdit({ from: plan.from, insert: plan.insert });
    return plan.id;
  }
  const result = await api.addBlockId({ path, ...fields, id: wanted ?? newBlockId(blockIdsIn(text)) });
  applyBlockIdResult(syncTarget, result);
  return result.id;
}

/** What the editor's `[[Note#^` completion needs (NoteContext.blocks); failures are toasted. */
export const editorBlocks: NonNullable<NoteContext['blocks']> = {
  noteText: readNoteText,
  ensureBlockId: (path, text, block, wanted) =>
    ensureBlockId(path, text, block, wanted).catch((e: unknown) => {
      toastError(e, 'Could not add the block id');
      throw e;
    }),
};
