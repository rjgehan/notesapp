// A rough passphrase check for the create dialog (DESIGN §6.33). The ciphertext sits in the
// vault, its git history and every backup, so a weak passphrase can be attacked offline for
// ever; PBKDF2 slows guessing down but cannot save a short one.

export const MIN_PASSPHRASE_LENGTH = 8;

/** Bits of a passphrase guessed by brute force over the character classes it uses (an upper bound). */
export function estimatedBits(passphrase: string): number {
  let pool = 0;
  if (/[a-z]/.test(passphrase)) pool += 26;
  if (/[A-Z]/.test(passphrase)) pool += 26;
  if (/[0-9]/.test(passphrase)) pool += 10;
  if (/[^a-zA-Z0-9]/.test(passphrase)) pool += 33;
  const distinct = new Set(passphrase).size;
  // Repeats ("aaaaaaaa", "abcabcabc") count for less than their length.
  const length = Math.min(passphrase.length, distinct * 2);
  return pool === 0 ? 0 : Math.round(length * Math.log2(pool));
}

/** Advice for a weak passphrase, or null. */
export function passphraseAdvice(passphrase: string): string | null {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) return null;
  if (estimatedBits(passphrase) < 60) return 'This passphrase is easy to guess. Four or more random words are both stronger and easier to remember.';
  return null;
}
