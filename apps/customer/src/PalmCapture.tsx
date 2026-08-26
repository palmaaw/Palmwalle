/**
 * PalmCapture — the live capture surface used by enrollment and self-test.
 *
 * Two modes, ONE extraction pipeline (@palma/biometrics runs identically in
 * browser and Node):
 *  - 'camera':    getUserMedia → hidden canvas → rgbaToGray
 *  - 'synthetic': dev-only procedural palm generator (no camera needed)
 *
 * Frames are gated by GEOMETRY (detectPalmRgba: a palm-sized skin blob is in
 * frame and roughly centered) and PHOTOMETRY (assessQuality) before the
 * shutter unlocks. The user takes each frame manually, following a per-pose
 * guide so the enrollment covers several hand angles. Only extracted vectors
 * are handed up — raw pixels never leave this component.
 */

import { useEffect, useRef, useState } from 'react';

import {
  assessQuality,
  detectPalmRgba,
  extractFromGray,
  rgbaToGray,
  SyntheticCaptureSource,
  demoSeed
} from '@palma/biometrics';
import type { DescriptorVector, GrayImage, PalmPresence } from '@palma/biometrics';
import type { QualityHint, QualityReportDTO } from '@palma/shared';

export type CaptureMode = 'camera' | 'synthetic';

const TICK_MS = 120;
/** Shutter stays locked until the frame has been continuously ready this long. */
const READY_HOLD_MS = 350;
const WORK_SIZE = 192;

/** The synthetic generator always renders a centered palm — skip geometry. */
const SYNTHETIC_PRESENT: PalmPresence = { present: true, centered: true, fill: 0.4, centroidX: 0.5, centroidY: 0.5 };

export interface CaptureResult {
  vectors: DescriptorVector[];
  quality: QualityReportDTO;
  mode: CaptureMode;
}

interface Props {
  mode: CaptureMode;
  /** Synthetic identity seed (camera mode ignores it). */
  demoSlug: string;
  required: number;
  title: string;
  subtitle?: string;
  onComplete(result: CaptureResult): void;
  onCancel(): void;
}

const HINT_COPY: Record<QualityHint, string> = {
  ok: 'Looking good',
  too_dark: 'Too dark — find better light',
  too_bright: 'Too bright — move out of direct light',
  low_contrast: 'Low contrast — bring your palm closer',
  too_blurry: 'Hold steady — image looks soft',
  center_palm: 'Center your palm in the outline',
  hold_steady: 'Hold still while we capture'
};

/** Per-frame pose guide — nudges the hand so frames cover different angles. */
const POSE_GUIDES = [
  'Flat, fingers together, inside the outline',
  'Tilt your palm slightly to the left',
  'Tilt your palm slightly to the right',
  'Move a little closer — fill the outline',
  'Pull back a little',
  'Rock your hand ~15° clockwise',
  'Rock your hand ~15° counter-clockwise'
];

type Status = 'starting' | 'error' | 'no-palm' | 'adjust' | 'ready' | 'captured';

export function PalmCapture({ mode, demoSlug, required, title, subtitle, onComplete, onCancel }: Props): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const workRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const sourceRef = useRef<SyntheticCaptureSource | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const vectorsRef = useRef<DescriptorVector[]>([]);
  // Latest analyzed frame + verdict, kept for the shutter to consume.
  const lastFrameRef = useRef<{ gray: GrayImage; presence: PalmPresence } | null>(null);
  const readySinceRef = useRef<number | null>(null);
  /** Until this timestamp the UI keeps showing the post-capture flash. */
  const flashUntilRef = useRef<number>(0);
  const finishedRef = useRef(false);

  const [status, setStatus] = useState<Status>(mode === 'camera' ? 'starting' : 'starting');
  const [hint, setHint] = useState<QualityHint>('center_palm');
  const [score, setScore] = useState(0);
  const [done, setDone] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [qualityOk, setQualityOk] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function setup(): Promise<void> {
      if (mode === 'synthetic') {
        if (!demoSlug) {
          setError('No demo identity selected — sign in first.');
          return;
        }
        sourceRef.current = new SyntheticCaptureSource(demoSeed(demoSlug), { size: 128 });
        setStatus('ready');
        readySinceRef.current = Date.now();
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 640 } },
          audio: false
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => undefined);
        }
        setStatus('no-palm');
      } catch (err) {
        const name = (err as DOMException)?.name ?? '';
        setError(
          name === 'NotAllowedError'
            ? 'Camera permission was denied. Allow camera access, or switch to demo palms.'
            : name === 'NotFoundError'
              ? 'No camera found on this device — switch to demo palms.'
              : `Camera unavailable (${name || 'error'}) — switch to demo palms.`
        );
        setStatus('error');
      }
    }
    void setup();

    return () => {
      cancelled = true;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, [mode, demoSlug]);

  useEffect(() => {
    if (status === 'error') return;

    timerRef.current = window.setInterval(() => {
      if (finishedRef.current) return;
      if (Date.now() < flashUntilRef.current) return; // post-capture flash window
      const frame = grabFrame();
      if (!frame) return;

      const q = assessQuality(frame.gray, frame.presence);
      lastFrameRef.current = frame;
      setScore(q.score);
      setQualityOk(q.hints.every((h) => h !== 'too_dark' && h !== 'too_bright' && h !== 'low_contrast' && h !== 'too_blurry'));
      setHint(q.hints[0] ?? 'ok');

      if (!frame.presence.present) {
        readySinceRef.current = null;
        setStatus('no-palm');
      } else if (!q.usable) {
        readySinceRef.current = null;
        setStatus('adjust');
      } else {
        // Require a short continuous hold so tapping mid-motion still lands on
        // a settled frame.
        const now = Date.now();
        if (readySinceRef.current === null) readySinceRef.current = now;
        setStatus(now - readySinceRef.current >= READY_HOLD_MS ? 'ready' : 'adjust');
      }
    }, TICK_MS);

    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- grabFrame is stable over refs
  }, [status === 'error']);

  /** Pull one frame (gray + presence input) from whichever source is active. */
  function grabFrame(): { gray: GrayImage; presence: PalmPresence } | null {
    if (mode === 'synthetic') {
      const src = sourceRef.current;
      const canvas = previewRef.current;
      if (!src || !canvas) return null;
      const frame = src.next();
      drawSynthetic(canvas, frame.data, frame.width, frame.height);
      return { gray: frame, presence: SYNTHETIC_PRESENT };
    }
    const video = videoRef.current;
    const canvas = workRef.current;
    if (!video || !canvas || video.videoWidth === 0) return null;
    // Center-crop square, scaled straight to the working resolution.
    const side = Math.min(video.videoWidth, video.videoHeight);
    canvas.width = WORK_SIZE;
    canvas.height = WORK_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, WORK_SIZE, WORK_SIZE);
    const img = ctx.getImageData(0, 0, WORK_SIZE, WORK_SIZE);
    return {
      gray: rgbaToGray(img.data, WORK_SIZE, WORK_SIZE),
      presence: detectPalmRgba(img.data, WORK_SIZE, WORK_SIZE)
    };
  }

  /** Shutter: capture one frame now, if the scene is still valid. */
  function takeFrame(): void {
    if (finishedRef.current || status !== 'ready') return;
    const frame = grabFrame();
    if (!frame) return;
    const q = assessQuality(frame.gray, frame.presence);
    if (!q.usable) {
      setStatus('adjust');
      setHint(q.hints[0] ?? 'center_palm');
      return;
    }
    vectorsRef.current.push(extractFromGray(frame.gray, frame.presence).vector);
    const done = vectorsRef.current.length;
    setDone(done);
    setScore(q.score);
    if (done >= required) {
      finishedRef.current = true;
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
      onComplete({ vectors: vectorsRef.current.splice(0), quality: q, mode });
      return;
    }
    setStatus('captured');
    flashUntilRef.current = Date.now() + 450;
    readySinceRef.current = null; // re-arm the hold before the next frame
  }

  const pct = Math.min(100, Math.round((done / required) * 100));
  const poseIdx = Math.min(done, POSE_GUIDES.length - 1);
  const shutterEnabled = status === 'ready';
  const statusLine =
    status === 'captured'
      ? 'Got it — now try the next angle'
      : status === 'ready'
        ? 'Hold steady — tap the shutter'
        : status === 'no-palm'
          ? 'Show your palm to the camera'
          : HINT_COPY[hint] ?? 'Adjust your palm';

  return (
    <div className="capture">
      <header className="capture-head">
        <button className="linklike" onClick={onCancel}>
          ← Back
        </button>
        <div>
          <h2>{title}</h2>
          {subtitle ? <p className="muted">{subtitle}</p> : null}
        </div>
      </header>

      <div className={`reticle ${status === 'ready' || status === 'captured' ? 'good' : ''}`}>
        {mode === 'camera' ? (
          <video ref={videoRef} playsInline muted autoPlay />
        ) : (
          <canvas ref={previewRef} width={128} height={128} className="synth-preview" />
        )}
        <svg viewBox="0 0 100 100" className="overlay" aria-hidden>
          {/* palm outline guide */}
          <path
            d="M43 99 C40 92 34 88 30 80 C27.5 74 26.5 66 27.5 59 C24 56 18 47 15 41 C12 35 14 29 19 31 C23 33 28 40 32 45 C33 47 34 47 34 44 C32 40 31 26 32 20 C32.5 15 39 15 39.5 20 C40 30 40 40 40.5 45 C41 38 41.5 18 44 13 C45 8.5 52 8.5 53 13 C54 22 53.5 38 53 45 C53.5 36 55 20 56.5 16 C58 11.5 63.5 12 64 16.5 C64.5 26 63.5 38 63 45 C63.5 38 65 32 66.5 30 C68 26.5 73.5 27.5 73.5 31.5 C74 38 72.5 44 71.5 47 C72.5 56 72 68 69.5 78 C67.5 86 64 92 62 98 L43 99 Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeDasharray="3 3"
            strokeLinejoin="round"
          />
          {/* thumb webbing guide */}
          <path d="M32 45 C35 49 39 50 43 50" fill="none" stroke="currentColor" strokeWidth="0.7" strokeDasharray="1.5 2" opacity="0.6" />
          <path d="M6 6 L18 6 M6 6 L6 18" strokeWidth="1.6" stroke="currentColor" fill="none" strokeLinecap="round" />
          <path d="M94 6 L82 6 M94 6 L94 18" strokeWidth="1.6" stroke="currentColor" fill="none" strokeLinecap="round" />
          <path d="M6 94 L18 94 M6 94 L6 82" strokeWidth="1.6" stroke="currentColor" fill="none" strokeLinecap="round" />
          <path d="M94 94 L82 94 M94 94 L94 82" strokeWidth="1.6" stroke="currentColor" fill="none" strokeLinecap="round" />
        </svg>
      </div>

      {error ? (
        <div className="callout warn">{error}</div>
      ) : status === 'starting' ? (
        <div className="muted center">Starting {mode === 'camera' ? 'camera' : 'demo palm'}…</div>
      ) : (
        <>
          <div className="pose-card">
            <strong>{statusLine}</strong>
            <span className="muted small">
              Frame {Math.min(done + 1, required)} of {required} · {POSE_GUIDES[poseIdx]}
            </span>
          </div>

          <div className="dots" role="progressbar" aria-valuenow={pct}>
            {Array.from({ length: required }, (_, i) => (
              <span key={i} className={`dot ${i < done ? 'filled' : ''}`} />
            ))}
          </div>

          <div className="shutter-row">
            <button
              className={`shutter ${shutterEnabled ? 'armed' : ''}`}
              onClick={takeFrame}
              disabled={!shutterEnabled}
              aria-label="Capture frame"
            >
              <span />
            </button>
          </div>

          <div className="capture-meta">
            <strong>{mode === 'camera' ? '🖐 Palm detected' : '✨ Demo palm'}</strong>
            <span className="muted">
              light/focus {qualityOk ? '✓' : '✗'} · detail {(score * 100).toFixed(0)}%
            </span>
          </div>
        </>
      )}

      <canvas ref={workRef} hidden />

      <p className="footnote">
        🔒 Frames are processed on your device. Only an irreversible mathematical summary is ever sent to the server —
        never images.
      </p>
    </div>
  );
}

/** Paint a grayscale frame ([0,1] floats) into a canvas (upscaled via CSS). */
function drawSynthetic(canvas: HTMLCanvasElement, data: Float32Array, w: number, h: number): void {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = Math.round((data[i] ?? 0) * 255);
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}
