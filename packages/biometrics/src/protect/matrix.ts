/**
 * Deterministic projection matrix for template protection.
 *
 * HKDF-style derivation is done with our own integer KDF (not WebCrypto's async
 * subtle.deriveBits) so the matrix can be built synchronously and identically in
 * browser and Node. ⚠️ SIMULATED-grade: this is NOT a certified KDF; the
 * confidentiality control that matters is AES-256-GCM encryption of templates at
 * rest. A certified SDK replaces all of this. See docs/BIOMETRICS.md.
 */

import { DESCRIPTOR_DIM, TEMPLATE_BITS } from '@palma/shared';
import { rngFromBytes } from '../prng.js';

const DIM = DESCRIPTOR_DIM;

let cached: { keyHex: string; matrix: Float32Array } | null = null;

/**
 * Expand key bytes into a deterministic TEMPLATE_BITS x DIM gaussian matrix
 * with entries ~ N(0, 1/DIM). Cached per key (single-process lifetime).
 */
export function projectionMatrix(masterKey: Uint8Array): Float32Array {
  const keyHex = toHex(masterKey);
  if (cached && cached.keyHex === keyHex) return cached.matrix;
  const rng = rngFromBytes(masterKey);
  const scale = Math.sqrt(1 / DIM);
  const m = new Float32Array(TEMPLATE_BITS * DIM);
  for (let i = 0; i < m.length; i++) {
    m[i] = rng.gauss() * scale;
  }
  cached = { keyHex, matrix: m };
  return m;
}

export function project(v: Float32Array, matrix: Float32Array): Float32Array {
  if (v.length !== DIM) throw new Error(`projection expects dim ${DIM}, got ${v.length}`);
  const out = new Float32Array(TEMPLATE_BITS);
  for (let r = 0; r < TEMPLATE_BITS; r++) {
    let acc = 0;
    const row = r * DIM;
    for (let c = 0; c < DIM; c++) acc += matrix[row + c]! * v[c]!;
    out[r] = acc;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
