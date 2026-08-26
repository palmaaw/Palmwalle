/**
 * Palm-presence detector: geometric gating over synthetic RGBA scenes.
 * Pure-node (no canvas) — frames are painted pixel-by-pixel into typed arrays.
 */

import { describe, expect, it } from 'vitest';

import { detectPalmRgba } from './image/presence.js';

const W = 192;
const H = 192;

/** Two skin tones spanning light/dark — both must land inside the YCbCr gate. */
const SKIN_LIGHT: [number, number, number] = [210, 170, 140];
const SKIN_DARK: [number, number, number] = [120, 80, 60];
const BACKGROUND: [number, number, number] = [10, 12, 14];

function paint(
  rgba: Uint8ClampedArray,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rgb: [number, number, number]
): void {
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
      const o = (y * W + x) * 4;
      rgba[o] = rgb[0];
      rgba[o + 1] = rgb[1];
      rgba[o + 2] = rgb[2];
      rgba[o + 3] = 255;
    }
  }
}

function blankFrame(): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(W * H * 4);
  paint(rgba, 0, 0, W, H, BACKGROUND);
  return rgba;
}

describe('detectPalmRgba', () => {
  it('finds a centered palm-sized blob across skin tones', () => {
    for (const skin of [SKIN_LIGHT, SKIN_DARK]) {
      const rgba = blankFrame();
      // Rounded "palm": central block plus finger strip, ~35% of frame.
      paint(rgba, 58, 96, 134, 160, skin);
      paint(rgba, 66, 34, 126, 96, skin);
      const p = detectPalmRgba(rgba, W, H);
      expect(p.present).toBe(true);
      expect(p.centered).toBe(true);
      expect(p.fill).toBeGreaterThan(0.08);
      expect(p.fill).toBeLessThan(0.92);
      expect(Math.abs(p.centroidX - 0.5)).toBeLessThan(0.22);
    }
  });

  it('rejects a blob too small to be a palm', () => {
    const rgba = blankFrame();
    paint(rgba, 90, 90, 104, 104, SKIN_LIGHT); // 14×14 px ≈ 0.5% of frame
    const p = detectPalmRgba(rgba, W, H);
    expect(p.present).toBe(false);
    expect(p.centered).toBe(false);
  });

  it('flags an off-center blob as present but not centered', () => {
    const rgba = blankFrame();
    paint(rgba, 4, 4, 74, 74, SKIN_LIGHT); // top-left corner
    const p = detectPalmRgba(rgba, W, H);
    expect(p.present).toBe(true);
    expect(p.centered).toBe(false);
    expect(p.centroidX).toBeLessThan(0.25);
  });

  it('rejects a uniform dark frame', () => {
    const p = detectPalmRgba(blankFrame(), W, H);
    expect(p.present).toBe(false);
    expect(p.fill).toBe(0);
  });

  it('rejects pure noise (no coherent blob)', () => {
    const rgba = new Uint8ClampedArray(W * H * 4);
    let s = 0x9e3779b9;
    const rand = () => {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < W * H; i++) {
      rgba[i * 4] = rand() * 255;
      rgba[i * 4 + 1] = rand() * 255;
      rgba[i * 4 + 2] = rand() * 255;
      rgba[i * 4 + 3] = 255;
    }
    const p = detectPalmRgba(rgba, W, H);
    expect(p.present).toBe(false);
  });
});
