/**
 * PalmCapture — the live capture surface used by enrollment and self-test.
 *
 * Two modes, ONE extraction pipeline (@palmwallet/biometrics runs identically in
 * browser and Node):
 *  - 'camera':    getUserMedia → hidden canvas → rgbaToGray
 *  - 'synthetic': dev-only procedural palm generator (no camera needed)
 *
 * Frames are gated by PHOTOMETRY (assessQuality) before the shutter unlocks.
 * Skin segmentation remains a best-effort hint only because camera white
 * balance and lighting vary widely. The user takes each frame manually,
 * following a per-pose guide so enrollment covers several hand angles. Only
 * extracted vectors are handed up — raw pixels never leave this component.
 */

import { useEffect, useRef, useState } from 'react';

import {
  assessQuality,
  detectPalmRgba,
  extractFromGray,
  rgbaToGray,
  SyntheticCaptureSource,
  demoSeed
} from '@palmwallet/biometrics';
import { cosine } from '@palmwallet/biometrics';
import type { DescriptorVector, GrayImage, PalmPresence } from '@palmwallet/biometrics';
import type { QualityHint, QualityReportDTO } from '@palmwallet/shared';

export type CaptureMode = 'camera' | 'synthetic';
export type HandSide = 'left' | 'right';

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
  hand?: HandSide;
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
  'Move closer — show the center of your palm, keeping fingertips out of frame',
  'Pull back a little',
  'Turn your palm slightly right (like turning a doorknob)',
  'Turn your palm slightly left (back to center)',
  'Close-up: show the center of your palm, with fingertips out of frame'
];

const POSE_TRANSFORMS = [
  'translate(0 0) scale(1)',
  'translate(-7 1) scale(1.04)',
  'translate(7 1) scale(1.04)',
  'translate(0 2) scale(1.22)',
  'translate(0 -2) scale(.78)',
  'translate(3 0) rotate(14 50 55)',
  'translate(-3 0) rotate(-14 50 55)',
  'translate(0 2) scale(1.35)'
];

type Status = 'starting' | 'error' | 'no-palm' | 'adjust' | 'ready' | 'captured';

export function PalmCapture({ mode, hand = 'right', demoSlug, required, title, subtitle, onComplete, onCancel }: Props): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const workRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const sourceRef = useRef<SyntheticCaptureSource | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const vectorsRef = useRef<DescriptorVector[]>([]);
  const presenceRef = useRef<PalmPresence[]>([]);
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
          video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
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

      // Geometry is guidance only: skin segmentation varies by camera and
      // lighting. Photometric quality is the reliable shutter gate.
      const q = assessQuality(frame.gray);
      lastFrameRef.current = frame;
      setScore(q.score);
      setQualityOk(q.hints.every((h) => h !== 'too_dark' && h !== 'too_bright' && h !== 'low_contrast' && h !== 'too_blurry'));
      setHint(q.hints[0] ?? 'ok');

      if (!q.usable) {
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
    const q = assessQuality(frame.gray);
    if (!q.usable) {
      setStatus('adjust');
      setHint(q.hints[0] ?? 'center_palm');
      return;
    }
    vectorsRef.current.push(extractFromGray(frame.gray, frame.presence).vector);
    presenceRef.current.push(frame.presence);
    const done = vectorsRef.current.length;
    setDone(done);
    setScore(q.score);
    if (done >= required) {
      let minConsistency = 1;
      for (let i = 0; i < vectorsRef.current.length; i++) {
        for (let j = i + 1; j < vectorsRef.current.length; j++) minConsistency = Math.min(minConsistency, cosine(vectorsRef.current[i]!, vectorsRef.current[j]!));
      }
      if (minConsistency < 0.25) {
        setError('These photos look like different palms. Please enroll one hand again.');
        vectorsRef.current = [];
        presenceRef.current = [];
        setDone(0);
        setStatus('error');
        return;
      }
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
        : hint === 'too_dark'
          ? 'Too dark — move to a brighter place'
          : hint === 'too_bright'
            ? 'Too bright — move away from direct light'
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
          <g className={poseIdx === 7 ? 'full-hand-guide hidden' : 'full-hand-guide'} transform={`${hand === 'right' ? 'translate(100 0) scale(-1 1) ' : ''}${POSE_TRANSFORMS[poseIdx]}`}>
          {/* palm outline guide */}
          <path
            d="M42 98 C39 91 33 87 30 80 C27 75 28 69 31 64 C25 65 19 63 15 59 C10 54 10 48 14 45 C18 42 23 45 28 49 L35 55 C36 56 37 55 36 52 L33 21 C32.5 16 35.5 13 39 13 C42 13 43.5 16 43.5 20 L44 42 C44 44 45 44 45 41 L46 13 C46 8 49 6 52 7 C55 8 56 11 55.5 15 L55 42 C55 44 56 44 56.5 41 L59 18 C59.5 13 62 11 65 12 C68 13 69 16 68.5 20 L67 43 C67 45 68 45 69 43 L72 31 C73 27 76 26 79 28 C82 30 82 33 81 37 L77 53 C77 63 75 73 71 81 C68 88 64 93 62 98 Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeDasharray="3 3"
            strokeLinejoin="round"
          />
          {/* thumb webbing guide */}
          <path d="M31 64 C35 61 39 58 43 56" fill="none" stroke="currentColor" strokeWidth="0.7" strokeDasharray="1.5 2" opacity="0.6" />
          </g>
          {poseIdx === 7 ? <ellipse cx="50" cy="58" rx="25" ry="34" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="3 3" /> : null}
          <path d="M6 6 L18 6 M6 6 L6 18" strokeWidth="1.6" stroke="currentColor" fill="none" strokeLinecap="round" />
          <path d="M94 6 L82 6 M94 6 L94 18" strokeWidth="1.6" stroke="currentColor" fill="none" strokeLinecap="round" />
          <path d="M6 94 L18 94 M6 94 L6 82" strokeWidth="1.6" stroke="currentColor" fill="none" strokeLinecap="round" />
          <path d="M94 94 L82 94 M94 94 L94 82" strokeWidth="1.6" stroke="currentColor" fill="none" strokeLinecap="round" />
        </svg>
        <span className="hand-label">{hand === 'left' ? 'LEFT' : 'RIGHT'} HAND</span>
      </div>

      {error ? (
        <div className="callout warn"><span>{error}</span><button className="ghost" onClick={() => { setError(null); setStatus('no-palm'); }}>Retake enrollment</button></div>
      ) : status === 'starting' ? (
        <div className="muted center">Starting {mode === 'camera' ? 'camera' : 'demo palm'}…</div>
      ) : (
        <>
          <div className="pose-card">
            <strong>{statusLine}</strong>
              <span className="muted small">
              Frame {Math.min(done + 1, required)} of {required} · {hand === 'left' ? 'Left' : 'Right'} hand · {POSE_GUIDES[poseIdx]}
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
            <strong>{mode === 'camera' ? (status === 'ready' || status === 'captured' ? '🖐 Palm detected' : '⌛ Waiting for palm') : '✨ Demo palm'}</strong>
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
