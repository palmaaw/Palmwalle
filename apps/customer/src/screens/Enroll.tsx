/**
 * Enrollment flow: intro (privacy promise) → live capture → success + 1:1
 * self-test. Re-enrollment supersedes the previous template server-side.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  buildEnrollmentCode,
  buildProbeCode,
  SyntheticCaptureSource,
  demoSeed,
  extractFromGray
} from '@palma/biometrics';
import { ENROLL_FRAMES_REQUIRED } from '@palma/shared';

import { api, ApiError } from '../api.js';
import { PalmCapture } from '../PalmCapture.js';
import type { CaptureMode, CaptureResult } from '../PalmCapture.js';
import { useSession } from '../state.js';

export function EnrollIntro(): JSX.Element {
  const navigate = useNavigate();
  const [mode, setMode] = useState<CaptureMode | null>(null);
  const cameraAvailable = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  return (
    <div className="screen">
      <button className="linklike" onClick={() => navigate(-1)}>
        ← Back
      </button>
      <h2>Enroll your palm</h2>

      <div className="card">
        <p>
          Your palm becomes your payment pass. We look at the pattern of lines and texture and compute a{' '}
          <b>mathematical summary</b> that only works for matching — it can't be reversed into an image of your hand.
        </p>
        <ul className="ticks">
          <li>📸 Images never leave your device</li>
          <li>🧮 This device turns them into an irreversible code before anything is sent</li>
          <li>🔐 Only that code is ever transmitted or stored — sealed with AES-256-GCM</li>
          <li>🖐️ Hold your palm ~20 cm away — we'll guide you through {ENROLL_FRAMES_REQUIRED} angles</li>
          <li>⏸️ You press the shutter for each frame, once your palm is detected</li>
          <li>🔁 You can delete or re-enroll any time in Settings</li>
        </ul>
      </div>

      {!cameraAvailable ? (
        <div className="callout info">
          No camera detected in this environment (cloud browsers often block getUserMedia). The demo-palm generator uses
          the exact same processing pipeline.
        </div>
      ) : null}

      <button className="primary" onClick={() => setMode(cameraAvailable ? 'camera' : 'synthetic')}>
        Start enrollment ({ENROLL_FRAMES_REQUIRED} frames)
      </button>
      {cameraAvailable ? (
        <button className="ghost" onClick={() => setMode('synthetic')}>
          Use demo palm instead (no camera)
        </button>
      ) : null}

      {mode ? <EnrollCapture mode={mode} /> : null}
    </div>
  );
}

function EnrollCapture({ mode }: { mode: CaptureMode }): JSX.Element {
  const navigate = useNavigate();
  const { demoSlug, protectionKey } = useSession();
  const [error, setError] = useState<string | null>(null);

  async function onComplete(result: CaptureResult): Promise<void> {
    if (!protectionKey) {
      setError('Secure capture not ready yet — one moment, then retake.');
      return;
    }
    try {
      // Fuse + project INTO A ONE-WAY CODE right here: vectors never leave
      // this device; the server receives only the protected code.
      const built = buildEnrollmentCode(result.vectors, protectionKey);
      await api.enrollPalm(
        built.code,
        result.quality,
        built.consistencyScore,
        ENROLL_FRAMES_REQUIRED,
        mode === 'synthetic' ? 'synthetic' : 'camera'
      );
      navigate('/enroll/success', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Enrollment failed');
    }
  }

  return (
    <>
      {error ? (
        <>
          <div className="callout warn">{error}</div>
          <button className="primary" onClick={() => setError(null)}>
            Try again
          </button>
        </>
      ) : (
        <PalmCapture
          mode={mode}
          demoSlug={demoSlug}
          required={ENROLL_FRAMES_REQUIRED}
          title="Capture your palm"
          subtitle="Follow the pose guide — take each frame with the shutter when your palm locks in"
          onComplete={(r) => void onComplete(r)}
          onCancel={() => navigate('/enroll/intro')}
        />
      )}
    </>
  );
}

export function EnrollSuccess(): JSX.Element {
  const navigate = useNavigate();
  const { demoSlug, protectionKey, setCustomer, customer } = useSession();
  const [selfTest, setSelfTest] = useState<{ decision: string; score: number; threshold: number } | null>(null);
  const [testing, setTesting] = useState(false);

  async function runSelfTest(): Promise<void> {
    if (!protectionKey) {
      setSelfTest({ decision: 'error: secure capture not ready — retry', score: 0, threshold: 0 });
      return;
    }
    setTesting(true);
    try {
      // Fresh probe frames (separate from the enrollment capture), fused and
      // protected on-device, verified 1:1 against the template just created.
      const src = new SyntheticCaptureSource(demoSeed(demoSlug), { size: 128 });
      const code = buildProbeCode(
        src.captureProbeFrames().map((f) => extractFromGray(f).vector),
        protectionKey
      );
      const d = await api.selfTest({
        code,
        quality: DEMO_PROBE_QUALITY
      });
      setSelfTest(d);
      if (customer) setCustomer({ ...customer, palmEnrolled: true });
    } catch (err) {
      setSelfTest({ decision: `error: ${err instanceof ApiError ? err.message : 'failed'}`, score: 0, threshold: 0 });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="screen center-screen">
      <div className="big-icon success">✅</div>
      <h2>Your palm is enrolled!</h2>
      <p className="muted">Your encrypted palm template replaced any earlier one.</p>

      <div className="card">
        <h3>Verify it works</h3>
        <p className="muted small">Run a live 1:1 check against your new template.</p>
        <button className="primary" disabled={testing} onClick={() => void runSelfTest()}>
          {testing ? 'Scanning…' : 'Run self-test'}
        </button>
        {selfTest ? (
          <SelfTestResult decision={selfTest.decision} score={selfTest.score} threshold={selfTest.threshold} />
        ) : null}
      </div>

      <button className="primary" onClick={() => navigate('/home', { replace: true })}>
        Go to my wallet
      </button>
    </div>
  );
}

export function SelfTestResult({
  decision,
  score,
  threshold
}: {
  decision: string;
  score: number;
  threshold: number;
}): JSX.Element | null {
  if (decision.startsWith('error:')) return <div className="callout warn">{decision}</div>;
  const ok = decision === 'match';
  return (
    <div className={`selftest ${ok ? 'good' : 'bad'}`}>
      <strong>{ok ? '✓ It matches you' : decision === 'no_match' ? '✗ Did not match' : `? ${decision}`}</strong>
      <span className="muted small">
        similarity {score.toFixed(3)} · threshold {threshold.toFixed(2)}
      </span>
    </div>
  );
}

const DEMO_PROBE_QUALITY = { score: 0.92, usable: true, brightness: 0.5, contrast: 0.9, sharpness: 0.9, hints: ['ok'] };
