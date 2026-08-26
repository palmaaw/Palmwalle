/**
 * Capture-quality assessment on the RAW grayscale frame (pre-normalization).
 * Drives the enrollment UX hints and the server-side "usable" gate.
 *
 * Two axes of judgment:
 *  - PHOTOGRAPHIC (this module): brightness / contrast / sharpness. Thresholds
 *    are set leniently for real cameras (dim rooms, flat skin-on-background
 *    scenes) — they only reject frames that are effectively blank, pitch dark,
 *    blown out, or featureless. Synthetic demo renders saturate all three.
 *  - GEOMETRIC (image/presence.ts): is a palm-sized blob actually in frame and
 *    centered? When a PalmPresence is supplied it participates in `usable` —
 *    a sharp photo of a wall must not enroll.
 *
 * `score` is a display gauge; the hard gates are the hints + presence flags.
 */

import { sobel } from './extract/hog.js';
import { imageStats } from './image/gray.js';
import type { PalmPresence } from './image/presence.js';
import type { GrayImage, QualityHint, QualityReport } from './types.js';

export function assessQuality(img: GrayImage, presence?: PalmPresence): QualityReport {
  const { mean, std } = imageStats(img);
  const { mag } = sobel(img);
  let magSum = 0;
  for (let i = 0; i < mag.length; i++) magSum += mag[i]!;
  const meanAbsGrad = magSum / mag.length;

  const brightness = clamp01(mean);
  // Real camera palm scenes: std ~0.05-0.15 -> healthy; blank wall < ~0.02.
  const contrast = clamp01(std / 0.06);
  // Downscaled live frames lose high frequencies; in-focus texture lands
  // ~0.05-0.2 mean abs gradient, lens-covered/featureless < ~0.02.
  const sharpness = clamp01(meanAbsGrad / 0.1);

  const hints: QualityHint[] = [];
  if (mean < 0.06) hints.push('too_dark');
  else if (mean > 0.92) hints.push('too_bright');
  if (std < 0.025) hints.push('low_contrast');
  if (meanAbsGrad < 0.02) hints.push('too_blurry');
  if (presence && !presence.present) hints.push('center_palm');
  else if (presence && !presence.centered) hints.push('center_palm');
  if (hints.length === 0) hints.push('ok');

  // Score: weighted product over the three photometric axes.
  let score = 1;
  score *= Math.min(1, Math.max(0.05, sharpness));
  score *= Math.min(1, Math.max(0.05, contrast));
  score *= brightness < 0.08 ? 0.5 : 1;
  score = clamp01(score);

  const usable =
    hints.includes('ok') && score >= 0.25 && (!presence || (presence.present && presence.centered));
  return {
    score: round4(score),
    usable,
    brightness: round4(brightness),
    contrast: round4(contrast),
    sharpness: round4(sharpness),
    hints
  };
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
