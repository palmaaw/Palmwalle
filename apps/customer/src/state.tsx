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
  signIn(token: string, customer: CustomerDTO): void;
  setCustomer(customer: CustomerDTO): void;
  signOut(): void;
  refresh(): Promise<void>;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): JSX.Element {
  const [customer, setCustomerState] = useState<CustomerDTO | null>(null);
  const [protectionKey, setProtectionKey] = useState<Uint8Array | null>(null);

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
        loadProtectionKey();
      })
      .catch(() => setToken(null));
  }, [loadProtectionKey]);

  const signIn = useCallback(
    (token: string, c: CustomerDTO) => {
      setToken(token);
      setCustomerState(c);
      loadProtectionKey();
    },
    [loadProtectionKey]
  );

  // Synthetic identity follows the session — any registered customer can
  // enroll; nothing to cache, so it can never go stale or vanish in a new tab.
  const demoSlug = customer ? slugForPhone(customer.phone) : '';

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
