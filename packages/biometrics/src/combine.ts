/**
 * Multi-frame fusion: element-wise mean of descriptor vectors + renormalization.
 * Averaging several stable frames suppresses per-frame noise.
 */

import type { DescriptorVector } from './types.js';

/** Cosine similarity. Normalizes internally, so inputs need not be unit vectors. */
export function cosine(a: DescriptorVector, b: DescriptorVector): number {
  if (a.dim !== b.dim) throw new Error('dim mismatch');
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.dim; i++) {
    const x = a.f[i]!;
    const y = b.f[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na * nb);
  return denom <= 1e-12 ? 0 : dot / denom;
}

export function l2Normalize(v: Float32Array): Float32Array {
  let sq = 0;
  for (let i = 0; i < v.length; i++) sq += v[i]! * v[i]!;
  const norm = Math.sqrt(sq);
  if (norm <= 1e-12) return v;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
  return v;
}

export function combineVectors(vs: DescriptorVector[]): DescriptorVector {
  if (vs.length === 0) throw new Error('no vectors to combine');
  const dim = vs[0]!.dim;
  const out = new Float32Array(dim);
  for (const v of vs) {
    if (v.dim !== dim) throw new Error('dim mismatch');
    for (let i = 0; i < dim; i++) out[i] = out[i]! + v.f[i]!;
  }
  for (let i = 0; i < dim; i++) out[i] = out[i]! / vs.length;
  return { dim, f: l2Normalize(out) };
}
