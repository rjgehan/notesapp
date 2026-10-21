// Card identity (DESIGN §6.34). A card's id is a hash of the text that asks it, so the same card
// gets the same id on every device without anything written into the note, and a move or rename
// of the note keeps it. Editing the question makes a new id; the client then adopts the old
// record when the edit was small (adoptOrphans in deck.ts).

/** 53-bit string hash (cyrb53), stable across engines. */
export function hash53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** `c` and the base-36 hash of the identifying parts. */
export function cardId(...parts: string[]): string {
  return 'c' + hash53(parts.join('\u0000')).toString(36);
}

/** Scheduling comments the Obsidian Spaced Repetition plugin writes: `<!--SR:!2021-08-20,13,290-->`. */
export const SR_COMMENT = /<!--SR:[^>]*-->/g;

/**
 * The text that identifies a card: SR comments removed, each line trimmed and its white space
 * collapsed, blank lines dropped. Re-wrapping or re-indenting a card keeps its id.
 */
export function normalizeCardText(text: string): string {
  return text
    .replace(SR_COMMENT, '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l !== '')
    .join('\n');
}

/** The start of a question on one line, as the server keeps it (API.md §34.1). */
export function frontHint(text: string): string {
  const line = normalizeCardText(text).replace(/\n/g, ' ');
  return line.length > 200 ? line.slice(0, 200) + '…' : line;
}

/** Similarity of two short texts in [0, 1]: 1 − Levenshtein distance / longer length. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const x = a.length > 300 ? a.slice(0, 300) : a;
  const y = b.length > 300 ? b.slice(0, 300) : b;
  const longer = Math.max(x.length, y.length);
  if (longer === 0) return 1;
  let prev = new Array<number>(y.length + 1);
  let cur = new Array<number>(y.length + 1);
  for (let j = 0; j <= y.length; j++) prev[j] = j;
  for (let i = 1; i <= x.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const cost = x.charCodeAt(i - 1) === y.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return 1 - prev[y.length] / longer;
}
