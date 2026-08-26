/**
 * Frame-stream generator over the synthetic renderer — stands in for a camera.
 */

import { ENROLL_FRAMES_REQUIRED, PROBE_FRAMES_REQUIRED } from '@palmwallet/shared';
import { demoSeed, renderSyntheticPalm, type RenderedPalm, type RenderOptions } from './palmRenderer.js';

export { demoSeed };
export type { RenderedPalm };

export class SyntheticCaptureSource {
  private stream = 0;

  constructor(
    /** Identity seed — pass `demoSeed(slug)`. */
    readonly seed: string,
    private readonly base: RenderOptions = {}
  ) {}

  /** Next frame of this identity, with fresh per-frame variation. */
  next(o: RenderOptions = {}): RenderedPalm {
    const frame: RenderOptions = {
      jitter: 0.02,
      rotationDeg: 2,
      noiseSigma: 0.008,
      brightnessDrift: 0.08,
      ...this.base,
      ...o,
      stream: this.stream++
    };
    return renderSyntheticPalm(this.seed, frame);
  }

  /**
   * A realistic enrollment session: ENROLL_FRAMES_REQUIRED frames with mild
   * variation, like a user holding their palm steady while the app samples.
   */
  captureEnrollmentFrames(count = ENROLL_FRAMES_REQUIRED): RenderedPalm[] {
    return Array.from({ length: count }, () =>
      this.next({ jitter: 0.03, rotationDeg: 3, noiseSigma: 0.01, brightnessDrift: 0.1 })
    );
  }

  /** A realistic verification session: several probe frames to average. */
  captureProbeFrames(count = PROBE_FRAMES_REQUIRED): RenderedPalm[] {
    return Array.from({ length: count }, () =>
      this.next({ jitter: 0.04, rotationDeg: 3, noiseSigma: 0.012, brightnessDrift: 0.12 })
    );
  }

  /** A single verification probe frame. */
  captureProbe(): RenderedPalm {
    return this.next({ jitter: 0.03, rotationDeg: 3, noiseSigma: 0.012, brightnessDrift: 0.12 });
  }
}
