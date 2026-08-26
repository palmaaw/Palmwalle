/**
 * POS sign-in + dev bootstrap (setup token guarded server-side).
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, ApiError } from '../api.js';
import { usePos } from '../state.js';

export function Login(): JSX.Element {
  const { signIn } = usePos();
  const navigate = useNavigate();
  const [identifier, setIdentifier] = useState('ZAMALEK-COFFEE');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [bootOpen, setBootOpen] = useState(false);
  const [bName, setBName] = useState('');
  const [bCode, setBCode] = useState('');
  const [bPhone, setBPhone] = useState('');
  const [bPin, setBPin] = useState('');
  const [bToken, setBToken] = useState('');

  async function login(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const d = await api.login(identifier.trim(), pin);
      signIn(d.accessToken, d.merchant);
      navigate('/pos', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  async function bootstrap(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const d = await api.registerMerchant(bToken.trim(), bName.trim(), bCode.trim().toUpperCase(), bPhone.trim(), bPin);
      signIn(d.accessToken, d.merchant);
      navigate('/pos', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Setup failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pos-login">
      <div className="hero">
        <h1>
          Palm<span>Pay</span> <em>POS</em>
        </h1>
        <p className="prototype-banner">⚠️ SIMULATED PROTOTYPE — demo biometrics · no real money</p>
      </div>

      <form onSubmit={(e) => void login(e)} className="card form">
        <h2>Merchant sign-in</h2>
        <label>
          Merchant code or phone
          <input value={identifier} onChange={(e) => setIdentifier(e.target.value)} placeholder="ZAMALEK-COFFEE" />
        </label>
        <label>
          PIN
          <input value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} type="password" inputMode="numeric" placeholder="2468 for the demo shop" />
        </label>
        {error ? <div className="callout warn">{error}</div> : null}
        <button className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Open till'}
        </button>
        <button type="button" className="ghost" onClick={() => setBootOpen((v) => !v)}>
          First run? Register this terminal
        </button>
      </form>

      {bootOpen ? (
        <form onSubmit={(e) => void bootstrap(e)} className="card form">
          <h3>Register a merchant (dev)</h3>
          <p className="muted small">
            Requires the dev setup token (<code>{'x-setup-token'}</code>). In production a licensed acquirer onboards
            merchants — never an open endpoint.
          </p>
          <label>
            Setup token
            <input value={bToken} onChange={(e) => setBToken(e.target.value)} placeholder="palma-dev-setup" />
          </label>
          <label>
            Shop name
            <input value={bName} onChange={(e) => setBName(e.target.value)} placeholder="Zamalek Coffee" />
          </label>
          <label>
            Merchant code
            <input value={bCode} onChange={(e) => setBCode(e.target.value.toUpperCase())} placeholder="ZAMALEK-COFFEE" />
          </label>
          <label>
            Phone
            <input value={bPhone} onChange={(e) => setBPhone(e.target.value)} placeholder="+201200000001" inputMode="tel" />
          </label>
          <label>
            PIN (4–6 digits)
            <input value={bPin} onChange={(e) => setBPin(e.target.value.replace(/\D/g, '').slice(0, 6))} type="password" inputMode="numeric" />
          </label>
          <button className="primary" disabled={busy}>
            Create & open till
          </button>
        </form>
      ) : null}
    </div>
  );
}
