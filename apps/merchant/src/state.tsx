/**
 * POS session + the synthetic-probe contract.
 *
 * ⚠️ SIMULATED MODE CONTRACT: without a palm scanner, the POS synthesizes
 * probes from demo identity slugs (the SAME demoSeed slugs the customer app
 * and seeder use). The seeded identities are quick-picks; a custom palm ID can
 * be typed to scan any other enrolled synthetic customer.
 *
 * DEVICE-SIDE PROTECTION: the reader fuses probe frames and projects them into
 * a one-way code with the session's protection subkey BEFORE upload — exactly
 * what certified reader hardware will do inside its secure element.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { buildProbeCode, base64ToBytes, demoSeed, extractFromGray, SyntheticCaptureSource } from '@palma/biometrics';

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
    if (!localStorage.getItem('palma.pos.token')) return;
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

/** Seeded demo identities — MUST match apps/cli/src/seed.ts slugs. */
export const DEMO_IDENTITIES = [
  { slug: 'aya', name: 'Aya Hassan', phone: '+201000000001', note: 'EGP 2,500' },
  { slug: 'omar', name: 'Omar Khaled', phone: '+201000000002', note: 'EGP 800' },
  { slug: 'nour', name: 'Nour Adel', phone: '+201000000003', note: 'EGP 0 — insufficient funds demo' }
] as const;

/**
 * Build a wire-shape probe for a demo identity slug: frames fused + protected
 * ON DEVICE with the session's subkey. Null until the key has loaded — callers
 * keep scan buttons disabled meanwhile.
 */
export function useProbeBuilder(): ((slug: string) => { code: { algoId: string; version: number; bits: string }; quality: unknown }) | null {
  const { protectionKey } = usePos();
  return useMemo(() => {
    if (!protectionKey) return null;
    return (slug: string) => {
      const src = new SyntheticCaptureSource(demoSeed(slug), { size: 128 });
      const vectors = src.captureProbeFrames().map((f) => extractFromGray(f).vector);
      return {
        code: buildProbeCode(vectors, protectionKey),
        quality: { score: 0.92, usable: true, brightness: 0.5, contrast: 0.9, sharpness: 0.9, hints: ['ok'] }
      };
    };
  }, [protectionKey]);
}
