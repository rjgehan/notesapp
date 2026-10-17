// One id per page load (API.md §2): X-Client-Id, SSE echo suppression and draft ownership.

function generate(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch {
      // randomUUID exists but throws on insecure origins in some browsers; fall through.
    }
  }
  // Insecure origins (plain-http tailnet dev) have no randomUUID: build one from getRandomValues.
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const clientId: string = generate();

/** A fresh id for an `Idempotency-Key` (8 to 64 characters of `[A-Za-z0-9-]`). */
export function newIdempotencyKey(): string {
  return generate();
}
