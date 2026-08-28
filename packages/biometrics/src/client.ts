/**
 * Client-side protection helpers — run INSIDE the capture device (customer PWA,
 * POS reader, or CLI seeder). This is where descriptors die: frames are
 * extracted, fused, and projected into a one-way 1024-bit code that never
 * leaves the device in any reversible form.
 */

import { ALGO_ID, TEMPLATE_BITS } from '@palmwallet/shared';
import type { PalmCodeDTO as PalmCodeWire } from '@palmwallet/shared';
import { cosine, combineVectors } from './combine.js';
import { protectVector } from './protect/protector.js';
import { encodeCode } from './codes.js';
import type { DescriptorVector } from './types.js';

export interface BuiltEnrollmentCode {
  code: PalmCodeWire;
  /** Frame consistency score sent to the server for enrollment quality checks. */
  consistencyScore: number;
}

/** Enrollment path: fuse all accepted frames and protect ON DEVICE. */
export function buildEnrollmentCode(vectors: DescriptorVector[], protectionKey: Uint8Array): BuiltEnrollmentCode {
  if (vectors.length === 0) throw new Error('enrollment requires at least one frame vector');
  let consistency = 0;
  let comparisons = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      consistency += cosine(vectors[i]!, vectors[j]!);
      comparisons++;
    }
  }
  const code = buildProbeCode(vectors, protectionKey);
  const average = comparisons ? consistency / comparisons : 1;
  return { code, consistencyScore: Math.round(Math.max(0, Math.min(1, average)) * 10000) / 10000 };
}

/** Probe path (POS scan / self-test): fuse probe frames and protect ON DEVICE. */
export function buildProbeCode(vectors: DescriptorVector[], protectionKey: Uint8Array): PalmCodeWire {
  const combined = combineVectors(vectors);
  return {
    algoId: ALGO_ID,
    version: 1,
    bits: encodeCode(protectVector(combined, protectionKey))
  };
}

/** Decode + length-check helper for tests/tools that hold raw bits. */
export function codeBitCount(): number {
  return TEMPLATE_BITS;
}
