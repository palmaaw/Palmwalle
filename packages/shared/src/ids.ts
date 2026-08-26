/**
 * ID helpers. Uses only WebCrypto globals so this runs in browsers AND Node >=19.
 */

export type RefKind = 'DP' | 'PM' | 'RF';

/** Random UUID (v4). */
export function newId(): string {
  return globalThis.crypto.randomUUID();
}

/** Client-generated unique id for idempotent requests. */
export function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Crockford-ish, no 0/O/1/I

/** Human-friendly reference like "PM-20260825-7F3K9Q" for receipts/support. */
export function newHumanRef(kind: RefKind, now: Date = new Date()): string {
  const y = String(now.getUTCFullYear()).padStart(4, '0');
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  let tail = '';
  for (const b of bytes) tail += REF_ALPHABET[b % REF_ALPHABET.length]!;
  return `${kind}-${y}${m}${d}-${tail}`;
}
