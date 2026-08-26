/**
 * SIMULATED feature extractor: Sobel gradients -> PYRAMID histograms of oriented
 * gradients pooled at three spatial scales (global, 2x2, 4x4 cells x 8 orientation
 * bins = 168 dims), per-cell L2 norm + global L2 norm.
 *
 * Pooling design notes (from the separation study in docs/BIOMETRICS.md):
 * - Large pooling regions make the descriptor tolerant of small capture jitter,
 *   which otherwise dominates bit similarity and makes identities collide.
 * - Orientation content carries the identity signal (synthetic ridge gratings),
 *   so it survives pooling; purely positional descriptors did not.
 *
 * This is NOT a real palm-recognition algorithm — see docs/BIOMETRICS.md.
 */

import { CELL_NORM_BETA, DESCRIPTOR_DIM } from '@palma/shared';
import type { GrayImage } from '../types.js';

export interface Gradients {
  mag: Float32Array;
  ori: Float32Array; // radians in [0, PI)
}

const BINS = 32;
/** Pyramid levels: side lengths in cells. Global + 2x2 quadrants.
 *  Translation does not change grating ORIENTATIONS, so coarse spatial pooling
 *  keeps the pose stability that finer grids destroyed in the separation study. */
const LEVELS = [1, 2];
/** Level emphasis: global orientation mix is the most stable signal. */
const LEVEL_WEIGHTS = [2, 1];

export function sobel(img: GrayImage): Gradients {
  const { width: w, height: h, data } = img;
  const mag = new Float32Array(w * h);
  const ori = new Float32Array(w * h);
  const at = (x: number, y: number): number =>
    data[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const gy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      const i = y * w + x;
      mag[i] = Math.hypot(gx, gy);
      let o = Math.atan2(gy, gx);
      if (o < 0) o += Math.PI;
      if (o >= Math.PI) o -= Math.PI;
      ori[i] = o;
    }
  }
  return { mag, ori };
}

/** Pyramid HOG with per-cell L2 normalization, concatenated and globally L2 normalized. */
export function hog(img: GrayImage): Float32Array {
  const { width: w, height: h } = img;
  const { mag, ori } = sobel(img);
  const binWidth = Math.PI / BINS;

  let totalCells = 0;
  for (const s of LEVELS) totalCells += s * s;
  const hist = new Float32Array(totalCells * BINS);

  // Accumulate every pixel into every pyramid level (cheap at these sizes).
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const m = mag[i]!;
      if (m <= 1e-9) continue;
      const bf = ori[i]! / binWidth;
      const b0 = Math.floor(bf) % BINS;
      const frac = bf - Math.floor(bf);
      const b1 = (b0 + 1) % BINS;
      let base = 0;
      for (const side of LEVELS) {
        const cx = Math.min(side - 1, Math.floor((x / w) * side));
        const cy = Math.min(side - 1, Math.floor((y / h) * side));
        const cellBase = (base + cy * side + cx) * BINS;
        hist[cellBase + b0] = hist[cellBase + b0]! + m * (1 - frac);
        hist[cellBase + b1] = hist[cellBase + b1]! + m * frac;
        base += side * side;
      }
    }
  }

  // Per-cell POWER normalization + level weighting.
  // Full unit-norm per cell amplifies weak junk cells (boundary ringing,
  // background residue — identical across identities) into shared mass; raw
  // magnitudes let big cells dominate. Exponent beta interpolates:
  // ||cell||_after = ||cell||_before^beta. NOTE: `base` advances by the WHOLE
  // level after its cells are normalized — an earlier version incremented it
  // per cell while indexing (base + c), normalizing the wrong blocks.
  {
    let base = 0;
    for (let li = 0; li < LEVELS.length; li++) {
      const side = LEVELS[li]!;
      const lw = LEVEL_WEIGHTS[li]!;
      for (let c = 0; c < side * side; c++) {
        const off = (base + c) * BINS;
        let sq = 0;
        for (let b = 0; b < BINS; b++) sq += hist[off + b]! ** 2;
        const norm = Math.sqrt(sq);
        if (norm > 1e-9) {
          const scale = Math.pow(norm, CELL_NORM_BETA - 1) * lw;
          for (let b = 0; b < BINS; b++) hist[off + b] = hist[off + b]! * scale;
        }
      }
      base += side * side;
    }
  }

  // global L2 normalization
  let gsq = 0;
  for (let i = 0; i < hist.length; i++) gsq += hist[i]! * hist[i]!;
  const g = Math.sqrt(gsq);
  if (g > 1e-9) {
    for (let i = 0; i < hist.length; i++) hist[i] = hist[i]! / g;
  }
  if (hist.length !== DESCRIPTOR_DIM) throw new Error(`Descriptor dim mismatch: ${hist.length} != ${DESCRIPTOR_DIM}`);
  return hist;
}
