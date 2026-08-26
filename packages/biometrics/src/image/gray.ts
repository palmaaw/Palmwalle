/**
 * Image primitives: RGBA -> grayscale, square crop, bilinear resize.
 * Pure functions over typed arrays; no canvas/DOM/node dependencies.
 */

import type { GrayImage } from '../types.js';

/** Convert RGBA pixel data (any alpha layout) to single-channel luma in [0,1]. */
export function rgbaToGray(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): GrayImage {
  const out = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const a = rgba.length > o + 3 ? rgba[o + 3]! / 255 : 1;
    // Composite onto black so transparent padding doesn't glow.
    const lum = (0.299 * rgba[o]! + 0.587 * rgba[o + 1]! + 0.114 * rgba[o + 2]!) / 255;
    out[i] = lum * a;
  }
  return { width, height, data: out };
}

/** Center-crop to the largest square. */
export function centerCropSquare(img: GrayImage): GrayImage {
  const side = Math.min(img.width, img.height);
  const x0 = Math.floor((img.width - side) / 2);
  const y0 = Math.floor((img.height - side) / 2);
  const out = new Float32Array(side * side);
  for (let y = 0; y < side; y++) {
    let src = (y0 + y) * img.width + x0;
    let dst = y * side;
    for (let x = 0; x < side; x++) {
      out[dst++] = img.data[src++]!;
    }
  }
  return { width: side, height: side, data: out };
}

/** Bilinear resize (clamped edges). */
export function resizeBilinear(img: GrayImage, w: number, h: number): GrayImage {
  if (img.width === w && img.height === h) return img;
  const out = new Float32Array(w * h);
  const sx = (img.width - 1) / (w - 1 || 1);
  const sy = (img.height - 1) / (h - 1 || 1);
  for (let y = 0; y < h; y++) {
    const fy = y * sy;
    const y0 = Math.min(Math.floor(fy), img.height - 1);
    const y1 = Math.min(y0 + 1, img.height - 1);
    const wy = fy - Math.floor(fy);
    for (let x = 0; x < w; x++) {
      const fx = x * sx;
      const x0 = Math.min(Math.floor(fx), img.width - 1);
      const x1 = Math.min(x0 + 1, img.width - 1);
      const wx = fx - Math.floor(fx);
      const p00 = img.data[y0 * img.width + x0]!;
      const p10 = img.data[y0 * img.width + x1]!;
      const p01 = img.data[y1 * img.width + x0]!;
      const p11 = img.data[y1 * img.width + x1]!;
      out[y * w + x] =
        p00 * (1 - wx) * (1 - wy) + p10 * wx * (1 - wy) + p01 * (1 - wx) * wy + p11 * wx * wy;
    }
  }
  return { width: w, height: h, data: out };
}

/** Separable box blur (repeated passes approximate a gaussian). Clamped edges. */
export function boxBlur(img: GrayImage, radius: number, passes = 2): GrayImage {
  if (radius < 1) return img;
  const { width: w, height: h } = img;
  let cur = Float32Array.from(img.data);
  const tmp = new Float32Array(w * h);
  for (let p = 0; p < passes; p++) {
    // horizontal
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let x = -radius; x <= radius; x++) acc += cur[row + Math.min(w - 1, Math.max(0, x))]!;
      const n = 2 * radius + 1;
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / n;
        const add = cur[row + Math.min(w - 1, x + radius + 1)]!;
        const sub = cur[row + Math.max(0, x - radius)]!;
        acc += add - sub;
      }
    }
    // vertical
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -radius; y <= radius; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]!;
      const n = 2 * radius + 1;
      for (let y = 0; y < h; y++) {
        cur[y * w + x] = acc / n;
        const add = tmp[Math.min(h - 1, y + radius + 1) * w + x]!;
        const sub = tmp[Math.max(0, y - radius) * w + x]!;
        acc += add - sub;
      }
    }
  }
  return { width: w, height: h, data: cur };
}

/** Pixelwise difference a - b as a new image. */
export function subtractImages(a: GrayImage, b: GrayImage): GrayImage {
  if (a.width !== b.width || a.height !== b.height) throw new Error('subtractImages size mismatch');
  const out = new Float32Array(a.data.length);
  for (let i = 0; i < out.length; i++) out[i] = a.data[i]! - b.data[i]!;
  return { width: a.width, height: a.height, data: out };
}

/** Statistics of an image (mean and population std). */
export function imageStats(img: GrayImage): { mean: number; std: number } {
  let sum = 0;
  for (let i = 0; i < img.data.length; i++) sum += img.data[i]!;
  const mean = sum / img.data.length;
  let acc = 0;
  for (let i = 0; i < img.data.length; i++) {
    const d = img.data[i]! - mean;
    acc += d * d;
  }
  return { mean, std: Math.sqrt(acc / img.data.length) };
}
