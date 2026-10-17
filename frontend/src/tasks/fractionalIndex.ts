// Fractional-index order keys (API.md §20.1): the base-62 algorithm of the `fractional-indexing`
// package (David Greenspan, "Implementing Fractional Indexing"), the same as the server's
// FractionalIndex, so an optimistic move shows the key the server is likely to choose. Keys
// compare as plain strings; equal keys sort by id.

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SMALLEST_INTEGER = 'A' + '0'.repeat(26);

/** Plain string order (code units), as the server compares keys. */
export function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2;
  if (head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2;
  return 0;
}

function integerPart(key: string): string {
  const length = integerLength(key[0]);
  if (length === 0 || length > key.length) throw new Error(`invalid order key: ${key}`);
  return key.slice(0, length);
}

function validate(key: string): void {
  if (key === '' || key === SMALLEST_INTEGER) throw new Error(`invalid order key: ${key}`);
  for (const ch of key) if (!DIGITS.includes(ch)) throw new Error(`invalid order key: ${key}`);
  const fraction = key.slice(integerPart(key).length);
  if (fraction.endsWith('0')) throw new Error(`invalid order key: ${key}`);
}

/** True for a key the algorithm can generate around (a hand-edited key may not be). */
export function isValidKey(key: string | null | undefined): boolean {
  if (typeof key !== 'string') return false;
  try {
    validate(key);
    return true;
  } catch {
    return false;
  }
}

function midpoint(a: string, b: string | null): string {
  if (b !== null && compareKeys(a, b) >= 0) throw new Error(`${a} >= ${b}`);
  if (a.endsWith('0') || (b !== null && b.endsWith('0'))) throw new Error('trailing zero');
  if (b !== null) {
    // Remove the longest common prefix, padding a with zeros as we go.
    let n = 0;
    while (n < b.length && (a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  // The first digits (or the lack of a digit) differ.
  const digitA = a ? DIGITS.indexOf(a[0]) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))];
  // The first digits are consecutive.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA] + midpoint(a.slice(1), null);
}

function incrementInteger(x: string): string | null {
  const head = x[0];
  const digits = x.slice(1).split('');
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]) + 1;
    if (d === DIGITS.length) digits[i] = '0';
    else {
      digits[i] = DIGITS[d];
      carry = false;
    }
  }
  if (!carry) return head + digits.join('');
  if (head === 'Z') return 'a0';
  if (head === 'z') return null;
  const h = String.fromCharCode(head.charCodeAt(0) + 1);
  const rest = digits.join('');
  return h > 'a' ? h + rest + '0' : h + rest.slice(0, -1);
}

function decrementInteger(x: string): string | null {
  const head = x[0];
  const digits = x.slice(1).split('');
  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digits[i]) - 1;
    if (d === -1) digits[i] = DIGITS[DIGITS.length - 1];
    else {
      digits[i] = DIGITS[d];
      borrow = false;
    }
  }
  if (!borrow) return head + digits.join('');
  if (head === 'a') return 'Z' + DIGITS[DIGITS.length - 1];
  if (head === 'A') return null;
  const h = String.fromCharCode(head.charCodeAt(0) - 1);
  const rest = digits.join('');
  return h < 'Z' ? h + rest + DIGITS[DIGITS.length - 1] : h + rest.slice(0, -1);
}

/**
 * A key strictly between `a` and `b` (null: unbounded). Throws when a key is invalid or
 * `a >= b`; callers then leave the order to the server.
 */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) validate(a);
  if (b !== null) validate(b);
  if (a !== null && b !== null && compareKeys(a, b) >= 0) throw new Error(`${a} >= ${b}`);
  if (a === null) {
    if (b === null) return 'a0';
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INTEGER) return ib + midpoint('', fb);
    if (compareKeys(ib, b) < 0) return ib;
    const decremented = decrementInteger(ib);
    if (decremented === null) throw new Error('cannot decrement any more');
    return decremented;
  }
  if (b === null) {
    const ia = integerPart(a);
    const fa = a.slice(ia.length);
    const incremented = incrementInteger(ia);
    return incremented === null ? ia + midpoint(fa, null) : incremented;
  }
  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  const ib = integerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const incremented = incrementInteger(ia);
  if (incremented === null) throw new Error('cannot increment any more');
  if (compareKeys(incremented, b) < 0) return incremented;
  return ia + midpoint(fa, null);
}
