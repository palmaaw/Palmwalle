/**
 * Settings: profile, password change, palm re-enroll/delete, sign out, disclosures.
 */

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api, ApiError } from '../api.js';
import { useSession } from '../state.js';

export function Settings(): JSX.Element {
  const { customer, signOut } = useSession();
  const navigate = useNavigate();

  return (
    <div className="screen">
      <h2>Settings</h2>

      <div className="card profile">
        <strong>{customer?.name}</strong>
        <span className="muted">{customer?.phone}</span>
      </div>

      <section>
        <h3>Palm</h3>
        <p className="muted small">
          {customer?.palmEnrolled
            ? 'A palm template is active. Re-enrolling replaces it; deleting disables palm payments.'
            : 'No palm enrolled yet.'}
        </p>
        <Link to="/enroll/intro" className="primary as-button">
          {customer?.palmEnrolled ? 'Re-enroll palm' : 'Enroll palm'}
        </Link>
        {customer?.palmEnrolled ? <DeletePalm onDeleted={() => void signOutSoft()} /> : null}
      </section>

      <ChangePassword />

      <section>
        <h3>About</h3>
        <div className="callout info">
          ⚠️ Palm Wallet is a <b>SIMULATED PROTOTYPE</b>. Balances live in a demo ledger — no real money moves. Biometric
          matching uses a research-grade simulated pipeline, not a certified SDK. Unlike a password, a biometric can't be
          rotated if compromised.
        </div>
      </section>

      <button
        className="ghost danger"
        onClick={() => {
          signOut();
          navigate('/', { replace: true });
        }}
      >
        Sign out
      </button>
    </div>
  );

  /** Delete requires the palm endpoint anyway; keep session if it fails. */
  async function signOutSoft(): Promise<void> {
    try {
      await api.me(); // confirm token still valid
    } catch {
      /* ignore */
    }
    signOut();
    navigate('/', { replace: true });
  }
}

function ChangePassword(): JSX.Element {
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNext] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setMsg(null);
    setError(null);
    try {
      await api.changePassword(currentPassword, newPassword);
      setMsg('Password changed ✓');
      setCurrent('');
      setNext('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change password');
    }
  }

  return (
    <section>
      <h3>Change password</h3>
      <form onSubmit={(e) => void submit(e)} className="card form">
        <label>
          Current password
          <input value={currentPassword} onChange={(e) => setCurrent(e.target.value)} type="password" autoComplete="current-password" />
        </label>
        <label>
          New password (min 6 characters)
          <input value={newPassword} onChange={(e) => setNext(e.target.value.slice(0, 128))} type="password" autoComplete="new-password" />
        </label>
        {msg ? <div className="callout good">{msg}</div> : null}
        {error ? <div className="callout warn">{error}</div> : null}
        <button className="primary">Update password</button>
      </form>
    </section>
  );
}

function DeletePalm({ onDeleted }: { onDeleted(): void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.deletePalm(password);
      setOpen(false);
      onDeleted();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not delete palm');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button className="ghost danger" onClick={() => setOpen(true)}>
        Delete my palm
      </button>
      {open ? (
        <div className="sheet-backdrop" onClick={() => setOpen(false)}>
          <form className="sheet" onClick={(e) => e.stopPropagation()} onSubmit={(e) => void submit(e)}>
            <h3>Delete palm?</h3>
            <p className="muted small">
              Your encrypted template will be revoked and palm payments disabled. You can enroll again anytime. Confirm
              with your password.
            </p>
            <label>
              Password
              <input
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value.slice(0, 128))}
                type="password"
                autoComplete="current-password"
              />
            </label>
            {error ? <div className="callout warn">{error}</div> : null}
            <button className="danger solid" disabled={busy}>
              {busy ? 'Deleting…' : 'Delete palm'}
            </button>
            <button type="button" className="ghost" onClick={() => setOpen(false)}>
              Keep my palm
            </button>
          </form>
        </div>
      ) : null}
    </>
  );
}
