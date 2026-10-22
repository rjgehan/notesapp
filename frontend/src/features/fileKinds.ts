// File kinds by extension (DESIGN §4.2), for paths that have no tree entry (history of a deleted
// file). Entries in the tree carry the server's `kind`, which always wins.
import type { FileKind } from '../api/types';
import { extensionOf } from './paths';

const TEXT = new Set('txt markdown json canvas excalidraw sheet tasks csv tsv yaml yml mdenc'.split(' '));
const BY_EXTENSION: Record<string, FileKind> = {};
for (const e of 'png jpg jpeg gif webp avif bmp svg'.split(' ')) BY_EXTENSION[e] = 'image';
for (const e of 'mp3 m4a ogg wav flac 3gp'.split(' ')) BY_EXTENSION[e] = 'audio';
for (const e of 'mp4 mov ogv webm mkv'.split(' ')) BY_EXTENSION[e] = 'video';
BY_EXTENSION.pdf = 'pdf';

export function kindOfPath(path: string): FileKind {
  const ext = extensionOf(path);
  if (ext === 'md') return 'note';
  if (TEXT.has(ext)) return 'text';
  return BY_EXTENSION[ext] ?? 'other';
}
