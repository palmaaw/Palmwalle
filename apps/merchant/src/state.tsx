/**
 * POS session + the synthetic-probe contract.
 *
 * ⚠️ SIMULATED MODE CONTRACT: without a palm scanner, the POS synthesizes a
 * probe from whatever palm is "presented". The till is IDENTITY-BLIND: it
 * never picks who is paying — it scans, protects the scan on device, and lets
 * the server identify the palm 1:N against enrolled templates (exactly like
 * real reader hardware).
 *
 * DEVICE-SIDE PROTECTION: the reader fuses probe frames and projects them into
 * a one-way code with the session's protection subkey BEFORE upload — exactly
 * what certified reader hardware will do inside its secure element.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { PROBE_FRAMES_REQUIRED } from '@palmwallet/shared';

import { assessQuality, buildProbeCode, base64ToBytes, demoSeed, extractFromGray, rgbaToGray, SyntheticCaptureSource } from '@palmwallet/biometrics';

import { api } from './api.js';
import type { MerchantDTO } from './api.js';
import { setToken } from './api.js';

interface PosSession {
  merchant: MerchantDTO | null;
  /** Device-visible protection subkey (memory-only); null until fetched. */
  protectionKey: Uint8Array | null;
  /** True while a stored token's session is still being restored on load —
   *  routers must not treat "merchant === null" as signed-out during this. */
  booting: boolean;
  signIn(token: string, m: MerchantDTO): void;
  signOut(): void;
}

const Ctx = createContext<PosSession | null>(null);

export function PosProvider({ children }: { children: ReactNode }): JSX.Element {
  const [merchant, setMerchant] = useState<MerchantDTO | null>(null);
  const [protectionKey, setProtectionKey] = useState<Uint8Array | null>(null);
  // Lazily initialized so a stored token never renders as "signed out" first.
  const [booting, setBooting] = useState<boolean>(() => !!localStorage.getItem('palm-wallet.pos.token'));

  const loadProtectionKey = useCallback((): void => {
    api
      .protectionKey()
      .then((d) => setProtectionKey(base64ToBytes(d.protectionKeyB64)))
      .catch(() => setProtectionKey(null));
  }, []);

  useEffect(() => {
    if (!localStorage.getItem('palm-wallet.pos.token')) return;
    api
      .me()
      .then((d) => {
        setMerchant(d.merchant);
        loadProtectionKey();
      })
      .catch(() => setToken(null))
      .finally(() => setBooting(false));
  }, [loadProtectionKey]);

  const value = useMemo<PosSession>(
    () => ({
      merchant,
      protectionKey,
      booting,
      signIn: (token, m) => {
        setToken(token);
        setMerchant(m);
        loadProtectionKey();
      },
      signOut: () => {
        setToken(null);
        setMerchant(null);
        setProtectionKey(null);
      }
    }),
    [merchant, protectionKey, booting, loadProtectionKey]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePos(): PosSession {
  const s = useContext(Ctx);
  if (!s) throw new Error('usePos outside PosProvider');
  return s;
}

/**
 * Palms the SIMULATED reader may see presented — slugs MUST match
 * apps/cli/src/seed.ts. The till itself never knows these names; the server
 * identifies whatever comes off the reader.
 */
/**
 * Read one palm from the live camera and return a wire-shape probe built on
 * device. Null means no valid palm frame is present; callers must not charge.
 */
export function usePalmReader(enabled = true): {
  read: () => Promise<{ code: { algoId: string; version: number; bits: string }; quality: unknown } | null>;
  readDemo: (slug: 'aya' | 'omar' | 'nour') => { code: { algoId: string; version: number; bits: string }; quality: unknown };
  videoRef: React.RefObject<HTMLVideoElement | null>;
  cameraReady: boolean;
} | null {
  const { protectionKey } = usePos();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  useEffect(() => {
    let stream: MediaStream | null = null;
    if (!enabled || !protectionKey || !navigator.mediaDevices?.getUserMedia) return;
    void navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 640 } }, audio: false })
      .then(async (s) => {
        stream = s;
        streamRef.current = s;
        setCameraReady(true);
      })
      .catch(() => setCameraReady(false));
    return () => {
      stream?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setCameraReady(false);
    };
  }, [enabled, protectionKey]);
  useEffect(() => {
    if (!cameraReady || !videoRef.current || !streamRef.current) return;
    videoRef.current.srcObject = streamRef.current;
    void videoRef.current.play().catch(() => undefined);
  }, [cameraReady]);
  return useMemo(() => {
    if (!protectionKey) return null;
    const read = async () => {
      const video = videoRef.current;
      const canvas = canvasRef.current ?? document.createElement('canvas');
      if (cameraReady && video && video.videoWidth > 0) {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;
        const vectors = [];
        let quality = null;
        const side = Math.min(video.videoWidth, video.videoHeight);
        for (let i = 0; i < PROBE_FRAMES_REQUIRED; i++) {
          canvas.width = 192; canvas.height = 192;
          ctx.drawImage(video, (video.videoWidth - side) / 2, (video.videoHeight - side) / 2, side, side, 0, 0, 192, 192);
          const pixels = ctx.getImageData(0, 0, 192, 192);
          const gray = rgbaToGray(pixels.data, 192, 192);
          // Camera skin segmentation is device-dependent; let the server-side
          // protected matcher decide identity instead of blocking good frames.
          quality = assessQuality(gray);
          if (!quality.usable) return null;
          vectors.push(extractFromGray(gray).vector);
          if (i < PROBE_FRAMES_REQUIRED - 1) await new Promise((resolve) => setTimeout(resolve, 80));
        }
        return { code: buildProbeCode(vectors, protectionKey), quality };
      }
      // Never silently invent a customer when a camera reader is active.
      // A missing/invalid frame must be handled as “no palm detected”.
      return null;
    };
    const readDemo = (slug: 'aya' | 'omar' | 'nour') => {
      const src = new SyntheticCaptureSource(demoSeed(slug), { size: 128 });
      return { code: buildProbeCode(src.captureProbeFrames().map((f) => extractFromGray(f).vector), protectionKey), quality: { score: 0.92, usable: true, brightness: 0.5, contrast: 0.9, sharpness: 0.9, hints: ['ok'] } };
    };
    return { read, readDemo, videoRef, cameraReady };
  }, [protectionKey, cameraReady]);
}
