// lz-string's base64 decompression (`LZString.decompressFromBase64` of lz-string 1.5.0, MIT) with
// a bound on the output, for Obsidian Excalidraw's compressed-json blocks (ROADMAP item 5, DESIGN
// §6.8.1). A few kilobytes of crafted codes can expand quadratically, to hundreds of millions of
// characters and past the engine's longest string; lz-string has no limit. The server's
// `drawings.LzString` is the same port. Compression stays lz-string's own.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
const VALUES = new Map([...ALPHABET].map((c, i) => [c, i]));
/** Each base64 character carries six bits, read from its highest (lz-string's resetValue 32). */
const RESET = 32;
/** Codes never get wider than this; a dictionary that large could not exist in memory anyway. */
const MAX_BITS = 30;

/**
 * The text `input` encodes (whitespace ignored), as lz-string decodes it: null for an empty or
 * invalid input and "" when the input ends early; also null when the text would be longer than
 * `maxLength` characters.
 */
export function decompressFromBase64(input: string, maxLength: number): string | null {
  const data = input.replace(/\s+/g, '');
  if (data === '') return null;
  // Characters outside the alphabet read as zero bits, as in lz-string.
  const valueAt = (i: number) => VALUES.get(data.charAt(i)) ?? 0;
  let value = valueAt(0);
  let position = RESET;
  let index = 1;
  const readBits = (count: number): number => {
    let bits = 0;
    for (let i = 0; i < count; i++) {
      const bit = value & position;
      position >>= 1;
      if (position === 0) {
        position = RESET;
        value = valueAt(index++);
      }
      if (bit !== 0) bits |= 1 << i;
    }
    return bits;
  };

  // Codes 0, 1 and 2 mean "an 8-bit character follows", "a 16-bit character follows" and "end".
  const dictionary: Array<string | null> = [null, null, null];
  let enlargeIn = 4;
  let numBits = 3;
  let first: string;
  switch (readBits(2)) {
    case 0:
      first = String.fromCharCode(readBits(8));
      break;
    case 1:
      first = String.fromCharCode(readBits(16));
      break;
    case 2:
      return '';
    default:
      return null;
  }
  dictionary.push(first);
  let previous = first;
  const result: string[] = [first];
  let length = first.length;
  for (;;) {
    if (index > data.length) return '';
    let code = readBits(numBits);
    if (code === 0 || code === 1) {
      dictionary.push(String.fromCharCode(readBits(code === 0 ? 8 : 16)));
      code = dictionary.length - 1;
      enlargeIn--;
    } else if (code === 2) {
      return result.join('');
    }
    if (enlargeIn === 0) {
      if (numBits >= MAX_BITS) return null;
      enlargeIn = 2 ** numBits;
      numBits++;
    }
    let entry: string | null;
    if (code < dictionary.length) entry = dictionary[code];
    else if (code === dictionary.length) entry = previous + previous.charAt(0);
    else return null;
    if (entry === null || length + entry.length > maxLength) return null;
    result.push(entry);
    length += entry.length;
    dictionary.push(previous + entry.charAt(0));
    enlargeIn--;
    previous = entry;
    if (enlargeIn === 0) {
      if (numBits >= MAX_BITS) return null;
      enlargeIn = 2 ** numBits;
      numBits++;
    }
  }
}
