/**
 * Wire codec for protected template codes.
 *
 * A "code" is the 1024-bit one-way template produced on a capture device. It is
 * the ONLY biometric-derived artifact that ever crosses the network — feature
 * descriptors are never transmitted, and the server has no path that accepts
 * them anymore. decodeCode() is the single validation gate at the API edge.
 */

import { ALGO_ID, TEMPLATE_BITS } from '@palma/shared';
import type { PalmCodeDTO as PalmCodeWire } from '@palma/shared';
import { base64ToBytes, bytesToBase64 } from './base64.js';

export const TEMPLATE_BYTES = TEMPLATE_BITS / 8;

export function encodeCode(bits: Uint8Array): string {
  if (bits.length !== TEMPLATE_BYTES) throw new Error(`code must be ${TEMPLATE_BYTES} bytes`);
  return bytesToBase64(bits);
}

/** Validate a wire code and return its packed bits. Throws on anything else. */
export function decodeCode(dto: PalmCodeWire): Uint8Array {
  if (dto.algoId !== ALGO_ID) throw new Error(`unsupported algoId ${dto.algoId}`);
  const bits = base64ToBytes(dto.bits);
  if (bits.length !== TEMPLATE_BYTES) {
    throw new Error(`code must be exactly ${TEMPLATE_BITS} bits (${TEMPLATE_BYTES} bytes), got ${bits.length}`);
  }
  return bits;
}
