/**
 * @palma/biometrics — SIMULATED biometric pipeline (see docs/BIOMETRICS.md).
 * Runs identically in browsers and Node: no node:* imports, no DOM-only globals.
 *
 * SECURITY SHAPE (prototype-grade, honest seams):
 *  - Extraction + protection run ON THE CAPTURE DEVICE (client.ts): only the
 *    one-way 1024-bit code ever crosses the network.
 *  - The device-visible PROTECTION subkey and the server-only STORAGE subkey
 *    are HKDF-derived separately from TEMPLATE_MASTER_KEY (protect/keys.ts).
 *  - The server stores sealed codes and matches by Hamming distance; it has no
 *    API or code path that accepts or creates descriptors.
 */

export * from './types.js';
export * from './prng.js';
export * from './base64.js';
export * from './image/gray.js';
export * from './image/normalize.js';
export { detectPalmRgba, type PalmPresence } from './image/presence.js';
export { hog, sobel } from './extract/hog.js';
export { boxBlur, subtractImages } from './image/gray.js';
export { extractFromGray, preprocess, SimHogExtractor, EXTRACT_SIZE } from './extract/extractor.js';
export { assessQuality } from './quality.js';
export { combineVectors, cosine, l2Normalize } from './combine.js';
export { derivePurposeKey, deriveRuntimeKeys, PURPOSE_PROTECTION, PURPOSE_STORAGE } from './protect/keys.js';
export { projectionMatrix, project } from './protect/matrix.js';
export { protectVector, binarize, packBits, unpackBits } from './protect/protector.js';
export { encodeCode, decodeCode, TEMPLATE_BYTES } from './codes.js';
export { buildEnrollmentCode, buildProbeCode } from './client.js';
export { sealBits, openSealed } from './protect/cipher.js';
export { hammingDistance, popcount, compareTemplates, bestMatch } from './match/matcher.js';
export { createBiometricService, type ServiceDeps } from './service.js';
export { InMemoryTemplateStore } from './memstore.js';
export {
  demoSeed,
  renderSyntheticPalm,
  type RenderOptions,
  type RenderedPalm
} from './synth/palmRenderer.js';
export { SyntheticCaptureSource } from './synth/captureSource.js';

import { demoSeed } from './synth/palmRenderer.js';
import { SyntheticCaptureSource } from './synth/captureSource.js';

/** Convenience: a capture source for a named demo identity slug. */
export function syntheticSourceFor(slug: string, size = 128): SyntheticCaptureSource {
  return new SyntheticCaptureSource(demoSeed(slug), { size });
}
