/**
 * Illumination normalization: zero-mean / unit-variance with outlier clamping,
 * so HOG gradients aren't dominated by exposure differences between frames.
 */

import type { GrayImage } from '../types.js';
import { imageStats } from './gray.js';

const CLAMP_SIGMAS = 3;

export function normalizeIllumination(img: GrayImage): GrayImage {
  const { mean, std } = imageStats(img);
  const s = std < 1e-6 ? 1e-6 : std;
  const lo = -CLAMP_SIGMAS * s;
  const hi = CLAMP_SIGMAS * s;
  const span = hi - lo;
  const out = new Float32Array(img.data.length);
  for (let i = 0; i < img.data.length; i++) {
    const z = Math.min(hi, Math.max(lo, img.data[i]! - mean));
    out[i] = (z - lo) / span; // back into [0,1]
  }
  return { width: img.width, height: img.height, data: out };
}
