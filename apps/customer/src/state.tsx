/**
 * Session state: the JWT + cached customer, persisted to localStorage so a
 * refresh keeps you signed in (prototype: no refresh tokens yet).
 *
 * The biometric PROTECTION KEY is deliberately NOT persisted: it lives only in
 * memory for the session and is re-fetched (authenticated) on reload. It is
 * what lets this device turn captures into one-way codes BEFORE anything is
 * uploaded — descriptors never exist on the network path.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { base64ToBytes } from '@palmwallet/biometrics';

import { api } from './api.js';
import type { CustomerDTO } from './api.js';
import { setToken } from './api.js';

interface Session {
  customer: CustomerDTO | null;
  /** Synthetic identity for THIS session — derived from the signed-in phone,
   *  so every registered customer (seeded or not) gets a stable demo palm that
   *  survives new tabs and reloads. Empty while signed out. */
  demoSlug: string;
  /** Device-visible protection subkey (memory-only); null until fetched. */
  protectionKey: Uint8Array | null;
  /** True while a stored token's session is still being restored on load —
   *  routers must not treat "customer === null" as signed-out during this. */
  booting: boolean;
  signIn(token: string, customer: CustomerDTO, phone?: string): void;
  setCustomer(customer: CustomerDTO): void;
  signOut(): void;
  refresh(): Promise<void>;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): JSX.Element {
  const [customer, setCustomerState] = useState<CustomerDTO | null>(null);
  const [demoSlug, setDemoSlug] = useState<string>(() => localStorage.getItem('palmwallet.demoSlug') ?? '');
  const [protectionKey, setProtectionKey] = useState<Uint8Array | null>(null);
  // Lazily initialized so a stored token never renders as "signed out" first.
  const [booting, setBooting] = useState<boolean>(() => !!localStorage.getItem('palmwallet.token'));

  const loadProtectionKey = useCallback((): void => {
    api
      .protectionKey()
      .then((d) => setProtectionKey(base64ToBytes(d.protectionKeyB64)))
      .catch(() => setProtectionKey(null));
  }, []);

  useEffect(() => {
    // Silent re-auth on load; 401 just means "not signed in".
    if (!localStorage.getItem('palmwallet.token')) return;
    api
      .me()
      .then((d) => {
        setCustomerState(d.customer);
        setDemoSlug((current) => current || slugForPhone(d.customer.phone ?? d.customer.id));
        loadProtectionKey();
      })
      .catch(() => setToken(null))
      .finally(() => setBooting(false));
  }, [loadProtectionKey]);

  const signIn = useCallback(
    (token: string, c: CustomerDTO, phone?: string) => {
      setToken(token);
      setCustomerState(c);
      const slug = slugForPhone(phone ?? c.phone ?? c.id);
      setDemoSlug(slug);
      localStorage.setItem('palmwallet.demoSlug', slug);
      loadProtectionKey();
    },
    [loadProtectionKey]
  );

  const value = useMemo<Session>(
    () => ({
      customer,
      demoSlug,
      protectionKey,
      booting,
      signIn,
      setCustomer: setCustomerState,
      signOut: () => {
        setToken(null);
        setCustomerState(null);
        setDemoSlug('');
        localStorage.removeItem('palmwallet.demoSlug');
        setProtectionKey(null);
      },
      refresh: async () => {
        if (!localStorage.getItem('palmwallet.token')) return;
        try {
          const d = await api.me();
          setCustomerState(d.customer);
        } catch {
          /* keep stale profile on transient errors */
        }
      }
    }),
    [customer, demoSlug, protectionKey, booting, signIn]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}

/** Egyptian numbers → stable synthetic-identity slug (+201001234567 → p201001234567). */
export function slugForPhone(phone: string | undefined): string {
  const value = typeof phone === 'string' ? phone : '';
  const digits = value.replace(/[^0-9]/g, '');
  // Keep the seeded demo palms compatible with the merchant's simulated
  // reader. Other accounts get a deterministic private slug of their own.
  const seeded: Record<string, string> = {
    '201000000001': 'aya',
    '201000000002': 'omar',
    '201000000003': 'nour'
  };
  return seeded[digits] ?? `p${digits}`;
}
