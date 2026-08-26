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

import { base64ToBytes } from '@palma/biometrics';

import { api } from './api.js';
import type { CustomerDTO } from './api.js';
import { setToken } from './api.js';

interface Session {
  customer: CustomerDTO | null;
  /** demoSlug names WHICH synthetic identity you are in dev mode. */
  demoSlug: string;
  /** Device-visible protection subkey (memory-only); null until fetched. */
  protectionKey: Uint8Array | null;
  signIn(token: string, customer: CustomerDTO): void;
  setCustomer(customer: CustomerDTO): void;
  signOut(): void;
  refresh(): Promise<void>;
}

const Ctx = createContext<Session | null>(null);

function readSlug(): string {
  return sessionStorage.getItem('palma.demoSlug') ?? '';
}

export function SessionProvider({ children }: { children: ReactNode }): JSX.Element {
  const [customer, setCustomerState] = useState<CustomerDTO | null>(null);
  const [demoSlug, setDemoSlug] = useState(readSlug);
  const [protectionKey, setProtectionKey] = useState<Uint8Array | null>(null);

  const loadProtectionKey = useCallback((): void => {
    api
      .protectionKey()
      .then((d) => setProtectionKey(base64ToBytes(d.protectionKeyB64)))
      .catch(() => setProtectionKey(null));
  }, []);

  useEffect(() => {
    // Silent re-auth on load; 401 just means "not signed in".
    if (!localStorage.getItem('palma.token')) return;
    api
      .me()
      .then((d) => {
        setCustomerState(d.customer);
        loadProtectionKey();
      })
      .catch(() => setToken(null));
  }, [loadProtectionKey]);

  const signIn = useCallback(
    (token: string, c: CustomerDTO) => {
      setToken(token);
      setCustomerState(c);
      loadProtectionKey();
      // In synthetic mode the palm is derived from this slug — keep it stable
      // per session and aligned with the phone you registered.
      sessionStorage.setItem('palma.demoSlug', slugForPhone(c.phone));
      setDemoSlug(slugForPhone(c.phone));
    },
    [loadProtectionKey]
  );

  const value = useMemo<Session>(
    () => ({
      customer,
      demoSlug,
      protectionKey,
      signIn,
      setCustomer: setCustomerState,
      signOut: () => {
        setToken(null);
        setCustomerState(null);
        setProtectionKey(null);
        sessionStorage.removeItem('palma.demoSlug');
        setDemoSlug('');
      },
      refresh: async () => {
        if (!localStorage.getItem('palma.token')) return;
        try {
          const d = await api.me();
          setCustomerState(d.customer);
        } catch {
          /* keep stale profile on transient errors */
        }
      }
    }),
    [customer, demoSlug, protectionKey, signIn]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}

/** Egyptian numbers → stable synthetic-identity slug (+201001234567 → p201001234567). */
export function slugForPhone(phone: string): string {
  return 'p' + phone.replace(/[^0-9]/g, '');
}
