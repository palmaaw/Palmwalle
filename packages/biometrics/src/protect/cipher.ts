/**
 * AES-256-GCM sealing of protected templates using WebCrypto
 * (`globalThis.crypto.subtle` — available in browsers and Node >= 20).
 *
 * Layout: nonce(12) || ciphertext(n) || tag(16). AAD binds the ciphertext to the
 * subject/template identity so rows cannot be swapped between accounts.
 *
 * This is the prototype's at-rest protection for biometric templates. It is a
 * REAL cipher, but the overall scheme is still SIMULATED-grade (see docs).
 */

import { IntegrityError } from '../types.js';
import type { SealedTemplate } from '../types.js';

const NONCE_LEN = 12;

/** WebCrypto key handle (type comes from the ambient crypto declaration —
 *  this package compiles for both browser and Node lib settings). */
type SubtleCryptoKey = Awaited<ReturnType<typeof globalThis.crypto.subtle.importKey>>;

async function importKey(masterKey: Uint8Array): Promise<SubtleCryptoKey> {
  if (masterKey.length !== 32) throw new Error('TEMPLATE_MASTER_KEY must be 32 bytes');
  return globalThis.crypto.subtle.importKey(
    'raw',
    masterKey.slice().buffer as ArrayBuffer,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function sealBits(bits: Uint8Array, storageKey: Uint8Array, aad: string): Promise<SealedTemplate> {
  const key = await importKey(storageKey);
  const nonce = new Uint8Array(NONCE_LEN);
  globalThis.crypto.getRandomValues(nonce);
  const ct = new Uint8Array(
    await globalThis.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce.buffer as ArrayBuffer, additionalData: new TextEncoder().encode(aad), tagLength: 128 },
      key,
      bits.slice().buffer as ArrayBuffer
    )
  );
  const out = new Uint8Array(NONCE_LEN + ct.length);
  out.set(nonce, 0);
  out.set(ct, NONCE_LEN);
  return { ciphertext: out, keyId: '' }; // keyId stamped by caller (service owns it)
}

export async function openSealed(sealed: SealedTemplate, storageKey: Uint8Array, aad: string): Promise<Uint8Array> {
  if (sealed.ciphertext.length < NONCE_LEN + 16) throw new IntegrityError('ciphertext too short');
  const key = await importKey(storageKey);
  const nonce = sealed.ciphertext.slice(0, NONCE_LEN);
  const ct = sealed.ciphertext.slice(NONCE_LEN);
  try {
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: nonce.buffer as ArrayBuffer, additionalData: new TextEncoder().encode(aad), tagLength: 128 },
      key,
      ct.buffer as ArrayBuffer
    );
    return new Uint8Array(plain);
  } catch {
    throw new IntegrityError();
  }
}
