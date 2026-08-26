/**
 * Purpose-separated key derivation from TEMPLATE_MASTER_KEY via WebCrypto HKDF
 * (SHA-256, available in browsers and Node >= 20).
 *
 * The master key itself is NEVER used directly for either job:
 *  - PURPOSE_PROTECTION derives the subkey that turns descriptors into one-way
 *    1024-bit codes. It ships to AUTHENTICATED capture devices so protection
 *    runs on-device and no descriptor ever crosses the network.
 *  - PURPOSE_STORAGE derives the server-only subkey for AES-256-GCM sealing of
 *    templates at rest. A leaked device/protection key therefore cannot decrypt
 *    stored templates, and a database leak alone yields nothing matchable.
 *
 * HKDF domain separation (distinct `info` labels) guarantees the two subkeys are
 * computationally independent even though they share a master.
 */

const encoder = new TextEncoder();

export const PURPOSE_PROTECTION = 'template-protection-v1';
export const PURPOSE_STORAGE = 'template-storage-sealing-v1';

/** Fixed non-secret salt; domain separation comes from the info label. */
const HKDF_SALT = encoder.encode('palm-wallet-hkdf-salt-v1');

/** Derive an independent 32-byte subkey for one purpose from the master key. */
export async function derivePurposeKey(masterKey: Uint8Array, purpose: string): Promise<Uint8Array> {
  if (masterKey.length !== 32) throw new Error('master key must be 32 bytes');
  const base = await globalThis.crypto.subtle.importKey(
    'raw',
    masterKey.slice().buffer as ArrayBuffer,
    'HKDF',
    false,
    ['deriveBits']
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: HKDF_SALT.slice().buffer as ArrayBuffer,
      info: encoder.encode(`palm-wallet:${purpose}`).buffer as ArrayBuffer
    },
    base,
    256
  );
  return new Uint8Array(bits);
}

/** Convenience: both runtime subkeys in one shot. */
export async function deriveRuntimeKeys(masterKey: Uint8Array): Promise<{ protectionKey: Uint8Array; storageKey: Uint8Array }> {
  const [protectionKey, storageKey] = await Promise.all([
    derivePurposeKey(masterKey, PURPOSE_PROTECTION),
    derivePurposeKey(masterKey, PURPOSE_STORAGE)
  ]);
  return { protectionKey, storageKey };
}
