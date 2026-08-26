/**
 * Welcome: brand hero + register/sign-in. Shared zod schemas from
 * @palma/shared validate on-device BEFORE hitting the API.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { CustomerLoginSchema, RegisterCustomerSchema } from '@palma/shared';

import { api, ApiError } from '../api.js';
import { useSession } from '../state.js';

export function Welcome(): JSX.Element {
  const [tab, setTab] = useState<'register' | 'login'>('register');
  const navigate = useNavigate();
  const { signIn } = useSession();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);

    if (tab === 'register') {
      const parsed = RegisterCustomerSchema.safeParse({ name: name.trim(), phone: phone.trim(), pin });
      if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check your details');
      try {
        setBusy(true);
        const d = await api.register(parsed.data.name, parsed.data.phone, parsed.data.pin);
        signIn(d.accessToken, d.customer);
        navigate('/enroll/intro', { replace: true });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Registration failed');
      } finally {
        setBusy(false);
      }
    } else {
      const parsed = CustomerLoginSchema.safeParse({ phone: phone.trim(), pin });
      if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? 'Check your details');
      try {
        setBusy(true);
        const d = await api.login(parsed.data.phone, parsed.data.pin);
        signIn(d.accessToken, d.customer);
        navigate(d.customer.palmEnrolled ? '/home' : '/enroll/intro', { replace: true });
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Sign-in failed');
      } finally {
        setBusy(false);
      }
    }
  }

  return (
    <div className="welcome">
      <div className="hero">
        <div className="logo" aria-hidden>
          ✋
        </div>
        <h1>
          Palm<span>Pay</span>
        </h1>
        <p className="tagline">Pay with a wave of your palm</p>
        <p className="prototype-banner">⚠️ SIMULATED PROTOTYPE — no real money, demo biometrics</p>
      </div>

      <div className="tabs">
        <button className={tab === 'register' ? 'active' : ''} onClick={() => setTab('register')}>
          Create account
        </button>
        <button className={tab === 'login' ? 'active' : ''} onClick={() => setTab('login')}>
          Sign in
        </button>
      </div>

      <form onSubmit={(e) => void submit(e)} className="card form">
        {tab === 'register' ? (
          <label>
            Full name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Aya Hassan" autoComplete="name" />
          </label>
        ) : null}

        <label>
          Mobile number
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+201012345678"
            inputMode="tel"
            autoComplete="tel"
          />
          <small>Egyptian numbers only (+2010/11/12/15…)</small>
        </label>

        <label>
          PIN
          <input
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
            placeholder="4–6 digits"
            inputMode="numeric"
            type="password"
            autoComplete={tab === 'register' ? 'new-password' : 'current-password'}
          />
        </label>

        {error ? <div className="callout warn">{error}</div> : null}

        <button className="primary" disabled={busy}>
          {busy ? 'Please wait…' : tab === 'register' ? 'Create my wallet' : 'Sign in'}
        </button>

        <p className="footnote">
          Demo tip: sign in as a seeded customer — <b>+201000000001</b>, PIN <b>1234</b>.
        </p>
      </form>
    </div>
  );
}
