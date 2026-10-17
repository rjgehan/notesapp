// Line endings at the DocumentSession boundary (DESIGN §4.4, §6.6, §6.9). Documents are LF-only
// inside the app; a file whose every line break is CRLF is converted back when it is serialized.

export type Eol = 'lf' | 'crlf';

/** `'crlf'` when the text has at least one line break and every `\n` is preceded by `\r`. */
export function detectEol(text: string): Eol {
  let breaks = 0;
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    if (i === 0 || text.charCodeAt(i - 1) !== 13) return 'lf';
    breaks++;
  }
  return breaks > 0 ? 'crlf' : 'lf';
}

/** Converts `\r\n` to `\n`. A lone `\r` is kept, as on the server. */
export function toLf(text: string): string {
  return text.includes('\r\n') ? text.replace(/\r\n/g, '\n') : text;
}

/** Serializes LF document text for the given line-ending style. */
export function fromLf(text: string, eol: Eol): string {
  return eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text;
}

/**
 * Maps a server offset (which counts `\r\n` as two code units) to an offset in the LF-only
 * document. An offset that points between `\r` and `\n` maps to the start of the line break.
 */
export function serverToDocOffset(docText: string, serverOffset: number, eol: Eol): number {
  if (eol === 'lf') return serverOffset;
  let server = 0;
  let doc = 0;
  while (doc < docText.length) {
    const width = docText.charCodeAt(doc) === 10 ? 2 : 1;
    if (server + width > serverOffset) return doc;
    server += width;
    doc++;
  }
  return doc;
}

/** Maps a document offset to the corresponding server offset. */
export function docToServerOffset(docText: string, docOffset: number, eol: Eol): number {
  if (eol === 'lf') return docOffset;
  let breaks = 0;
  for (let i = docText.indexOf('\n'); i >= 0 && i < docOffset; i = docText.indexOf('\n', i + 1)) breaks++;
  return docOffset + breaks;
}
