/**
 * Template protection: random projection -> sign binarization -> packed bits.
 *
 * Runs ON THE CAPTURE DEVICE with the device-visible PROTECTION subkey — the
 * only place descriptors ever exist alongside the key that one-ways them.
 *
 * Cancelable-biometrics STYLE transform: the stored artifact is a 1024-bit code
 * derived through a secret random projection. It is one-way (the continuous
 * descriptor cannot be recovered from the sign pattern) and re-issuable (a new
 * projection matrix yields fresh codes). ⚠️ Still SIMULATED-grade — not a
 * certified protection scheme; palms themselves can never be "rotated" like
 * passwords. See docs/BIOMETRICS.md for the honest threat model.
 */

import { TEMPLATE_BITS } from '@palmwallet/shared';
import type { DescriptorVector } from '../types.js';
import { project, projectionMatrix } from './matrix.js';

/** Project and binarize into TEMPLATE_BITS packed bits (LSB-first per byte). */
export function protectVector(v: DescriptorVector, protectionKey: Uint8Array): Uint8Array {
  const matrix = projectionMatrix(protectionKey);
  return packBits(binarize(project(v.f, matrix)));
}

export function binarize(projection: Float32Array): Uint8Array {
  const bits = new Uint8Array(projection.length);
  for (let i = 0; i < projection.length; i++) bits[i] = projection[i]! >= 0 ? 1 : 0;
  return bits;
}

export function packBits(bits: Uint8Array): Uint8Array {
  if (bits.length !== TEMPLATE_BITS) throw new Error(`expected ${TEMPLATE_BITS} bits`);
  const bytes = new Uint8Array(TEMPLATE_BITS / 8);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) bytes[i >> 3] = bytes[i >> 3]! | (1 << (i & 7));
  }
  return bytes;
}

export function unpackBits(bytes: Uint8Array): Uint8Array {
  const bits = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bits.length; i++) bits[i] = (bytes[i >> 3]! >> (i & 7)) & 1;
  return bits;
}
