/**
 * Palm-presence detection on RAW camera pixels (RGBA).
 *
 * Answers "is a hand-shaped blob of skin in frame, roughly centered?" — the
 * geometric gate the photometric quality score can't express. Classic YCbCr
 * skin segmentation + connected-component analysis; no ML, no dependencies,
 * runs identically in browser and Node.
 *
 * Deliberately coarse: it gates the capture UX (show/center/ready), not the
 * biometrics. A false accept just means we extract a bad frame that matching
 * will reject anyway.
 */

export interface PalmPresence {
  /** A plausible palm-sized skin blob exists in frame. */
  present: boolean;
  /** The blob's center is near the frame center (within CENTER_TOLERANCE). */
  centered: boolean;
  /** Largest skin component as a fraction of frame area, [0,1]. */
  fill: number;
  /** Component centroid in frame coords, [0,1] (0 = left/top). */
  centroidX: number;
  centroidY: number;
}

/** Analysis grid step: sample every Nth pixel in both axes (frame is ~192px). */
const SAMPLE_STEP = 3;
/** YCbCr skin range (Chai & Ngan style, slightly widened for varied tones). */
const CB_MIN = 77;
const CB_MAX = 133;
const CR_MIN = 130;
const CR_MAX = 180;
/** Ignore near-black samples — dark backgrounds classify as anything. */
const LUMA_MIN = 40;
/** Blob size bounds as fraction of frame area (palm fills a good chunk). */
const FILL_MIN = 0.08;
const FILL_MAX = 0.92;
/** Centroid must sit this close to the frame center to count as centered. */
const CENTER_TOLERANCE = 0.22;

/**
 * Detect a palm-sized skin blob in an RGBA frame.
 * Pure function over typed arrays — safe for any runtime.
 */
export function detectPalmRgba(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): PalmPresence {
  const gw = Math.max(1, Math.floor(width / SAMPLE_STEP));
  const gh = Math.max(1, Math.floor(height / SAMPLE_STEP));
  const mask = new Uint8Array(gw * gh);

  for (let gy = 0; gy < gh; gy++) {
    const py = gy * SAMPLE_STEP * 4 * width;
    for (let gx = 0; gx < gw; gx++) {
      const o = py + gx * SAMPLE_STEP * 4;
      const r = rgba[o]!;
      const g = rgba[o + 1]!;
      const b = rgba[o + 2]!;
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      if (y < LUMA_MIN) continue;
      const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
      const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
      if (cb >= CB_MIN && cb <= CB_MAX && cr >= CR_MIN && cr <= CR_MAX) mask[gy * gw + gx] = 1;
    }
  }

  // Largest 4-connected component via iterative flood fill.
  const visited = new Uint8Array(gw * gh);
  let bestArea = 0;
  let bestSumX = 0;
  let bestSumY = 0;
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    stack.length = 0;
    stack.push(start);
    visited[start] = 1;
    let area = 0;
    let sumX = 0;
    let sumY = 0;
    while (stack.length > 0) {
      const idx = stack.pop()!;
      const x = idx % gw;
      const y = (idx / gw) | 0;
      area++;
      sumX += x;
      sumY += y;
      if (x > 0 && mask[idx - 1] && !visited[idx - 1]) (visited[idx - 1] = 1), stack.push(idx - 1);
      if (x < gw - 1 && mask[idx + 1] && !visited[idx + 1]) (visited[idx + 1] = 1), stack.push(idx + 1);
      if (y > 0 && mask[idx - gw] && !visited[idx - gw]) (visited[idx - gw] = 1), stack.push(idx - gw);
      if (y < gh - 1 && mask[idx + gw] && !visited[idx + gw]) (visited[idx + gw] = 1), stack.push(idx + gw);
    }
    if (area > bestArea) {
      bestArea = area;
      bestSumX = sumX;
      bestSumY = sumY;
    }
  }

  const gridArea = gw * gh;
  const fill = bestArea / gridArea;
  const present = fill >= FILL_MIN && fill <= FILL_MAX;
  const centroidX = bestArea > 0 ? bestSumX / bestArea / gw : 0.5;
  const centroidY = bestArea > 0 ? bestSumY / bestArea / gh : 0.5;
  const centered =
    present &&
    Math.abs(centroidX - 0.5) <= CENTER_TOLERANCE &&
    Math.abs(centroidY - 0.5) <= CENTER_TOLERANCE;

  return { present, centered, fill: round4(fill), centroidX: round4(centroidX), centroidY: round4(centroidY) };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
