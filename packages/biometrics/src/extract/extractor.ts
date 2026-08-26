/**
 * The default SIMULATED FeatureExtractor used by both apps:
 * gray -> center-square crop -> 96x96 -> high-pass -> illumination normalize
 *      -> pyramid HOG -> population mean-centering -> unit renormalize.
 *
 * Its output (a float vector) NEVER leaves the device: the caller fuses frames
 * and projects them into a one-way code with client.ts before anything is sent.
 *
 * Separation-study notes (docs/BIOMETRICS.md):
 * - The high-pass runs BEFORE illumination normalization and removes the
 *   palm-vs-background blob structure that is IDENTICAL for every identity.
 * - Population mean-centering removes the residual shared component of all
 *   descriptors (identities' orientation mixes correlate ~0.7 raw). An earlier
 *   attempt failed because the renderer saturated its dynamic range and the
 *   mean was estimated under mismatched capture parameters — both fixed; the
 *   estimation error is now ~1/sqrt(96) of the between-identity spread.
 */

import {
  DESCRIPTOR_DIM,
  POPULATION_MEAN_SAMPLES, POPULATION_MEAN_SEED_NS
} from '@palmwallet/shared';
import { boxBlur, centerCropSquare, resizeBilinear, subtractImages } from '../image/gray.js';
import { normalizeIllumination } from '../image/normalize.js';
import type { PalmPresence } from '../image/presence.js';
import { assessQuality } from '../quality.js';
import { l2Normalize } from '../combine.js';
import { renderSyntheticPalm } from '../synth/palmRenderer.js';
import type { DescriptorVector, ExtractResult, FeatureExtractor, GrayImage } from '../types.js';
import { hog } from './hog.js';

export const EXTRACT_SIZE = 96;

/**
 * Preprocessing chain shared by every capture path. High-pass comes BEFORE
 * illumination normalization so exposure stats are computed on texture only.
 *
 * Note: centroid ROI alignment was tried and REJECTED — cropping to the blob
 * amplifies shared structure and hurt separation.
 */
export function preprocess(img: GrayImage): GrayImage {
  const resized = resizeBilinear(centerCropSquare(img), EXTRACT_SIZE, EXTRACT_SIZE);
  const hp = subtractImages(resized, boxBlur(resized, 4, 2));
  return normalizeIllumination(hp);
}

/**
 * Deterministically-rendered population mean descriptor, cached per process.
 * MUST track the capture paths: variation parameters are midpoints of the
 * enrollment ({jitter:.03, rot 3°, sigma .01, drift .1}) and probe
 * ({jitter:.04, rot 3°, sigma .012, drift .12}) sessions. A mismatch here was
 * the failure mode of the first centering attempt — captures kept a common
 * residual offset and inter-identity similarity stayed high.
 */
let meanCache: Float32Array | null = null;
export function populationMean(): Float32Array {
  if (meanCache) return meanCache;
  const acc = new Float32Array(DESCRIPTOR_DIM);
  for (let i = 0; i < POPULATION_MEAN_SAMPLES; i++) {
    const img = renderSyntheticPalm(`${POPULATION_MEAN_SEED_NS}:${i}`, {
      size: 128,
      stream: i,
      jitter: 0.035,
      rotationDeg: 3,
      noiseSigma: 0.011,
      brightnessDrift: 0.11
    });
    const f = hog(preprocess(img));
    for (let j = 0; j < DESCRIPTOR_DIM; j++) acc[j] = acc[j]! + f[j]!;
  }
  for (let j = 0; j < DESCRIPTOR_DIM; j++) acc[j] = acc[j]! / POPULATION_MEAN_SAMPLES;
  meanCache = acc;
  return acc;
}

/** Raw (non-normalized) frame -> descriptor vector + quality report. */
export function extractFromGray(img: GrayImage, presence?: PalmPresence): ExtractResult {
  const normalized = preprocess(img);
  const h = hog(normalized);
  if (h.length !== DESCRIPTOR_DIM) throw new Error('descriptor layout mismatch');
  // Center against the population: identities become deviations from the mean
  // (pairwise cosines scatter around ~0) instead of variations of a shared
  // silhouette+texture profile (pairwise cosines stuck at ~0.7+).
  const mean = populationMean();
  for (let j = 0; j < DESCRIPTOR_DIM; j++) h[j] = h[j]! - mean[j]!;
  // Back to unit norm so similarity math sees comparable magnitudes (centered
  // components are an order of magnitude smaller than raw HOG components).
  l2Normalize(h);

  const vector: DescriptorVector = { dim: DESCRIPTOR_DIM, f: h };
  return { vector, quality: assessQuality(img, presence) };
}

export class SimHogExtractor implements FeatureExtractor {
  extract(img: GrayImage): ExtractResult {
    return extractFromGray(img);
  }
}
