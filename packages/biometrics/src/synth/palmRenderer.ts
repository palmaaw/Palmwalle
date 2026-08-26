/**
 * SIMULATED capture source: procedural "palm" images derived deterministically
 * from an identity seed. This is what makes PalmPay demonstrable and testable in
 * environments with no camera (CI, cloud workspaces) — it is NOT a biometric
 * sensor and produces no personally meaningful data.
 *
 * Same seed => same underlying "palm" (creases, ridges, finger gaps, shading),
 * with per-frame jitter/noise/exposure drift like repeated real captures.
 */

import type { GrayImage } from '../types.js';
import { rngFromString, type Rng } from '../prng.js';

/** Canonical seed for a demo identity slug — THE shared contract between apps/seeder/tests. */
export function demoSeed(identitySlug: string): string {
  return `palma-demo-v1:${identitySlug}`;
}

export interface RenderOptions {
  /** Output square size in pixels. */
  size?: number;
  /** Translation jitter as fraction of size (per axis, uniform). */
  jitter?: number;
  /** Rotation jitter amplitude, degrees. */
  rotationDeg?: number;
  /** Per-pixel gaussian noise sigma (in [0,1] luminance units). */
  noiseSigma?: number;
  /** Exposure drift amplitude: gain in [1-d,1+d], offset ±d/2. */
  brightnessDrift?: number;
  /** Frame number within the capture session (advances variation). */
  stream?: number;
}

interface Identity {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  rot: number;
  fingers: Array<{ x: number; halfW: number; len: number; tilt: number }>;
  creases: Array<{ x0: number; y0: number; cx: number; cy: number; x1: number; y1: number; w: number; depth: number }>;
  minorCreases: Array<{ x0: number; y0: number; cx: number; cy: number; x1: number; y1: number; w: number; depth: number }>;
  /** Ridge-flow fields: local grating patches (like real ridges flowing in regions). */
  ridgeFields: Array<{ x: number; y: number; s: number; theta: number; freq: number; phase: number; amp: number }>;
  blotches: Array<{ x: number; y: number; r: number; amp: number }>;
}

function buildIdentity(seed: string): Identity {
  const r = rngFromString(seed);
  const cx = 0.5 + r.range(-0.02, 0.02);
  const cy = 0.54 + r.range(-0.02, 0.02);
  const rx = r.range(0.27, 0.33);
  const ry = r.range(0.32, 0.38);

  const fingers: Identity['fingers'] = [];
  const nFingers = 4;
  let fx = cx - r.range(0.16, 0.2);
  for (let k = 0; k < nFingers; k++) {
    fingers.push({
      x: fx,
      halfW: r.range(0.028, 0.042),
      len: r.range(0.16, 0.26),
      tilt: r.range(-0.06, 0.06)
    });
    fx += r.range(0.085, 0.115);
  }

  // Ridge-flow fields draw their angle/frequency from 3 IDENTITY-SPECIFIC flow
  // clusters (like real palms' loop/whorl/arch directions), forced well apart so
  // every histogram has three comparable, identity-unique peaks. Independently
  // uniform angles used to sprinkle every bin (~flat profiles for everyone).
  const nClusters = 3;
  const clusterAngles: number[] = [];
  const clusterFreqs: number[] = [];
  const clusterWeights: number[] = [];
  for (let c = 0; c < nClusters; c++) {
    // rejection-sample an angle >= ~26° from already-chosen clusters
    let a = 0;
    for (let tries = 0; tries < 60; tries++) {
      a = r.range(0, Math.PI);
      const ok = clusterAngles.every(b => {
        const d = Math.abs(a - b);
        return Math.min(d, Math.PI - d) >= 0.45;
      });
      if (ok) break;
    }
    clusterAngles.push(a);
    clusterFreqs.push(r.range(10, 28));
    clusterWeights.push(r.range(0.55, 1.45));
  }

  const ridgeFields: Identity['ridgeFields'] = [];
  {
    const COLS = 5;
    const ROWS = 4;
    for (let gy = 0; gy < ROWS; gy++) {
      for (let gx = 0; gx < COLS; gx++) {
        if (r.range(0, 1) < 0.15) continue; // occasional gap, like real ridge scars
        const nx = (gx + 0.5 + r.range(-0.3, 0.3)) / COLS - 0.5;
        const ny = (gy + 0.5 + r.range(-0.3, 0.3)) / ROWS - 0.5;
        if ((nx * 2) ** 2 + (ny * 2) ** 2 > 0.92) continue; // stay inside the oval
        const cl = Math.floor(r.range(0, nClusters));
        ridgeFields.push({
          x: cx + nx * 1.7 * rx,
          y: cy + ny * 1.7 * ry,
          s: r.range(0.05, 0.085),
          theta: clusterAngles[cl]! + r.gauss() * 0.12,
          freq: clusterFreqs[cl]! * r.range(0.9, 1.12),
          phase: r.range(0, Math.PI * 2),
          amp: 0.21 * clusterWeights[cl]!
        });
      }
    }
  }
  if (ridgeFields.length === 0) {
    ridgeFields.push({ x: cx, y: cy, s: 0.12, theta: clusterAngles[0] ?? 0, freq: clusterFreqs[0] ?? 16, phase: 0, amp: 0.2 });
  }
  const fieldAngle = (): number => ridgeFields[Math.floor(r.range(0, ridgeFields.length))]!.theta;

  // Creases are laid out so their GRADIENTS (perpendicular to the crease
  // tangent) land on the palm's own cluster angles — an earlier version aligned
  // tangents to field angles, injecting gradient mass at angle+90° and re-creating
  // a quasi-uniform orientation baseline.
  const creases: Identity['creases'] = [];
  for (let k = 0; k < 3; k++) {
    const mx = cx + r.range(-rx * 0.45, rx * 0.45);
    const my = cy + r.range(-ry * 0.6, ry * 0.35);
    const gradAng = fieldAngle();
    const tx = -Math.sin(gradAng);
    const ty = Math.cos(gradAng);
    const half = r.range(0.08, 0.16);
    const bendX = Math.cos(gradAng) * r.range(-0.05, 0.05);
    const bendY = Math.sin(gradAng) * r.range(-0.05, 0.05);
    creases.push({
      x0: mx - tx * half,
      y0: my - ty * half,
      x1: mx + tx * half,
      y1: my + ty * half,
      cx: mx + bendX,
      cy: my + bendY,
      w: r.range(0.006, 0.013),
      depth: r.range(0.3, 0.5)
    });
  }

  const minorCreases: Identity['minorCreases'] = [];
  const nMinor = Math.floor(r.range(4, 8));
  for (let k = 0; k < nMinor; k++) {
    const gradAng = fieldAngle();
    const tx = -Math.sin(gradAng);
    const ty = Math.cos(gradAng);
    const mx = cx + r.range(-rx * 0.8, rx * 0.8);
    const my = cy + r.range(-ry * 0.7, ry * 0.7);
    const half = r.range(0.025, 0.08);
    minorCreases.push({
      x0: mx - tx * half,
      y0: my - ty * half,
      x1: mx + tx * half,
      y1: my + ty * half,
      // small perpendicular bend for a natural look
      cx: mx + Math.cos(gradAng) * r.range(-0.02, 0.02),
      cy: my + Math.sin(gradAng) * r.range(-0.02, 0.02),
      w: r.range(0.004, 0.009),
      depth: r.range(0.15, 0.3)
    });
  }

  // Blotches kept only as very faint pigmentation variance — isotropic bumps add
  // gradient mass in EVERY orientation bin equally (a flat shared baseline).
  const blotches: Identity['blotches'] = [];
  for (let k = 0; k < 4; k++) {
    blotches.push({
      x: cx + r.range(-rx, rx),
      y: cy + r.range(-ry, ry),
      r: r.range(0.05, 0.16),
      amp: r.range(-0.02, 0.02)
    });
  }

  return { cx, cy, rx, ry, rot: r.range(-0.05, 0.05), fingers, creases, minorCreases, ridgeFields, blotches };
}

const identityCache = new Map<string, Identity>();
function identityFor(seed: string): Identity {
  let id = identityCache.get(seed);
  if (!id) {
    id = buildIdentity(seed);
    if (identityCache.size > 64) identityCache.clear();
    identityCache.set(seed, id);
  }
  return id;
}

export interface RenderedPalm extends GrayImage {
  rgba: Uint8ClampedArray;
}

/** Render one frame of the synthetic palm. Deterministic per (seed, options). */
export function renderSyntheticPalm(seed: string, o: RenderOptions = {}): RenderedPalm {
  const size = o.size ?? 128;
  const stream = o.stream ?? 0;
  const id = identityFor(seed);
  const fr = rngFromString(`${seed}|frame:${stream}`);

  const jitX = fr.range(-(o.jitter ?? 0), o.jitter ?? 0) * size;
  const jitY = fr.range(-(o.jitter ?? 0), o.jitter ?? 0) * size;
  const rot = ((o.rotationDeg ?? 0) === 0 ? 0 : fr.range(-(o.rotationDeg ?? 0), o.rotationDeg ?? 0)) * (Math.PI / 180)
    + id.rot;
  const gain = 1 + (o.brightnessDrift ? fr.range(-o.brightnessDrift, o.brightnessDrift) : 0);
  const offset = o.brightnessDrift ? fr.range(-o.brightnessDrift / 2, o.brightnessDrift / 2) : 0;
  const sigma = o.noiseSigma ?? 0;

  const cosR = Math.cos(-rot);
  const sinR = Math.sin(-rot);
  const data = new Float32Array(size * size);
  const rgba = new Uint8ClampedArray(size * size * 4);

  // Palm membership test in identity space (oval + finger bands).
  const insideAt = (ux: number, uy: number): boolean => {
    const dx = ux - id.cx;
    const dy = uy - id.cy;
    if ((dx / id.rx) ** 2 + (dy / id.ry) ** 2 <= 1) return true;
    for (const f of id.fingers) {
      // Finger bands rise from the top of the palm oval with a slight tilt.
      const bandX = ux - (f.x + f.tilt * Math.max(0, id.cy - id.ry * 0.4 - uy));
      const bandTop = id.cy - id.ry * 0.55 - f.len;
      if (Math.abs(bandX) <= f.halfW && uy >= bandTop && uy <= id.cy - id.ry * 0.45) return true;
    }
    return false;
  };

  // Erosion margin (~4px): pixels near the silhouette edge render as background
  // so the palm outline produces NO gradient at all. The boundary was identical
  // for every identity; its step edge wrapped around every orientation bin and
  // dominated descriptors until inter-identity similarity sat at ~0.85+.
  const erode = 4 / size;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // screen -> centered coords -> inverse rotate -> identity space
      const sx = (px - size / 2 - jitX) / size;
      const sy = (py - size / 2 - jitY) / size;
      const ux = sx * cosR - sy * sinR + id.cx;
      const uy = sx * sinR + sy * cosR + id.cy;

      // Flat dark background: ZERO gradients outside the palm so background
      // cells contribute nothing to the descriptor (noise here previously got
      // amplified by per-cell normalization and drowned identity texture).
      let v = 0.05;

      const insidePalm =
        insideAt(ux, uy) &&
        insideAt(ux + erode, uy) && insideAt(ux - erode, uy) &&
        insideAt(ux, uy + erode) && insideAt(ux, uy - erode);

      if (insidePalm) {
        // Flat interior base: any large-scale shading (radial falloff etc.) is
        // isotropic-gradient filler shared by every identity — excluded on purpose.
        v = 0.52;
        // Ridge-flow fields: hard nearest-field (Voronoi) assignment. Gaussian
        // blending left wide transition bands where two clusters' gratings mix,
        // filling every between-peak orientation bin identically for all
        // identities; hard assignment keeps local texture purely single-cluster.
        {
          let bestD2 = Infinity;
          let best: Identity['ridgeFields'][number] | null = null;
          for (const rf of id.ridgeFields) {
            const dx = ux - rf.x;
            const dy = uy - rf.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < bestD2) {
              bestD2 = d2;
              best = rf;
            }
          }
          if (best) {
            v += best.amp * Math.sin(2 * Math.PI * best.freq * (ux * Math.cos(best.theta) + uy * Math.sin(best.theta)) + best.phase);
          }
        }
        // Blotches.
        for (const b of id.blotches) {
          const d2 = (ux - b.x) ** 2 + (uy - b.y) ** 2;
          v += b.amp * Math.exp(-d2 / (b.r * b.r));
        }
        // Creases: darken near curves with soft edges.
        for (const c of id.creases) {
          const d = distToQuadBezier(ux, uy, c.x0, c.y0, c.cx, c.cy, c.x1, c.y1);
          v -= c.depth * softEdge(d, c.w);
        }
        for (const c of id.minorCreases) {
          const d = distToSegment(ux, uy, c.x0, c.y0, c.x1, c.y1);
          v -= c.depth * softEdge(d, c.w);
        }
      }

      v = v * gain + offset + (sigma > 0 ? fr.gauss() * sigma : 0);
      v = Math.min(1, Math.max(0, v));
      data[py * size + px] = v;
      const q = Math.round(v * 255);
      const o4 = (py * size + px) * 4;
      rgba[o4] = q;
      rgba[o4 + 1] = Math.round(q * 0.96);
      rgba[o4 + 2] = Math.round(q * 0.88);
      rgba[o4 + 3] = 255;
    }
  }

  return { width: size, height: size, data, rgba };
}

function softEdge(d: number, w: number): number {
  const t = Math.min(1, Math.max(0, 1 - d / (w * 1.6)));
  return t * t * (3 - 2 * t);
}

function distToSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const vx = x1 - x0;
  const vy = y1 - y0;
  const wx = px - x0;
  const wy = py - y0;
  const len2 = vx * vx + vy * vy || 1e-12;
  const t = Math.min(1, Math.max(0, (wx * vx + wy * vy) / len2));
  return Math.hypot(px - (x0 + t * vx), py - (y0 + t * vy));
}

function distToQuadBezier(
  px: number, py: number,
  x0: number, y0: number, cx: number, cy: number, x1: number, y1: number
): number {
  // Coarse sampling is plenty at these resolutions.
  let best = Infinity;
  const steps = 24;
  let prevX = x0;
  let prevY = y0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const bx = mt * mt * x0 + 2 * mt * t * cx + t * t * x1;
    const by = mt * mt * y0 + 2 * mt * t * cy + t * t * y1;
    best = Math.min(best, distToSegment(px, py, prevX, prevY, bx, by));
    prevX = bx;
    prevY = by;
  }
  return best;
}
