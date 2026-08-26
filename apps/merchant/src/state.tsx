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

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { buildProbeCode, base64ToBytes, demoSeed, extractFromGray, SyntheticCaptureSource } from '@palmwallet/biometrics';

import { api } from './api.js';
import type { MerchantDTO } from './api.js';
import { setToken } from './api.js';

interface PosSession {
  merchant: MerchantDTO | null;
  /** Device-visible protection subkey (memory-only); null until fetched. */
  protectionKey: Uint8Array | null;
  signIn(token: string, m: MerchantDTO): void;
  signOut(): void;
}

const Ctx = createContext<PosSession | null>(null);

export function PosProvider({ children }: { children: ReactNode }): JSX.Element {
  const [merchant, setMerchant] = useState<MerchantDTO | null>(null);
  const [protectionKey, setProtectionKey] = useState<Uint8Array | null>(null);

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
      .catch(() => setToken(null));
  }, [loadProtectionKey]);

  const value = useMemo<PosSession>(
    () => ({
      merchant,
      protectionKey,
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
    [merchant, protectionKey, loadProtectionKey]
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
const PRESENTED_PALMS = ['aya', 'omar', 'nour'] as const;
/** Occasionally an unenrolled palm walks up — rejection is a normal outcome. */
const UNENROLLED_CHANCE = 0.12;

/**
 * Read one palm: returns a wire-shape probe built ON DEVICE from fused frames
 * of whichever palm was just presented. Null until the protection key has
 * loaded — callers keep the scan button disabled meanwhile.
 */
export function usePalmReader(): (() => { code: { algoId: string; version: number; bits: string }; quality: unknown }) | null {
  const { protectionKey } = usePos();
  return useMemo(() => {
    if (!protectionKey) return null;
    return () => {
      const stranger = Math.random() < UNENROLLED_CHANCE;
      const slug = stranger ? 'unknown-stranger' : PRESENTED_PALMS[Math.floor(Math.random() * PRESENTED_PALMS.length)]!;
      const src = new SyntheticCaptureSource(demoSeed(slug), { size: 128 });
      const vectors = src.captureProbeFrames().map((f) => extractFromGray(f).vector);
      return {
        code: buildProbeCode(vectors, protectionKey),
        quality: { score: 0.92, usable: true, brightness: 0.5, contrast: 0.9, sharpness: 0.9, hints: ['ok'] }
      };
    };
  }, [protectionKey]);
}
