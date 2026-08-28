/**
 * Home: balance card, palm-ready chip, simulated top-up sheet, recent activity.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { formatEGP, toPiasters } from '@palmwallet/shared';
import type { DepositSource } from '@palmwallet/shared';
import { MIN_DEPOSIT_PIASTERS, MAX_DEPOSIT_PIASTERS } from '@palmwallet/shared';

import { api, ApiError } from '../api.js';
import type { TransactionDTO, WalletDTO } from '../api.js';
import { useSession } from '../state.js';

export function Home(): JSX.Element {
  const { customer, setCustomer } = useSession();
  const [wallet, setWallet] = useState<WalletDTO | null>(null);
  const [recent, setRecent] = useState<TransactionDTO[]>([]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [w, t] = await Promise.all([api.wallet(), api.transactions(undefined, 3)]);
      setWallet(w.wallet);
      setRecent(t.items);
      if (customer) {
        const s = await api.palmStatus();
        setCustomer({ ...customer, palmEnrolled: s.enrolled });
      }
    } catch (err) {
      // Keep the signed-in shell usable when the API is temporarily unavailable
      // and tell the user exactly how to recover instead of showing a blank page.
      setLoadError(err instanceof ApiError ? err.message : 'Could not load your wallet');
    } finally {
      setLoading(false);
    }
  }, [customer, setCustomer]);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once
  }, []);

  return (
    <div className="screen">
      <h2>
        Hi, {customer?.name?.split(' ')[0] ?? 'there'} 👋
      </h2>

      <div className="balance-card">
        <span className="muted">Available balance</span>
        <strong className="balance">{wallet ? wallet.formatted ?? formatEGP(wallet.balancePiasters) : loading ? '…' : '—'}</strong>
        <span className="sim-badge">SIMULATED WALLET</span>
      </div>

      {loadError ? (
        <div className="callout warn load-error" role="alert">
          <strong>Wallet data unavailable</strong>
          <span>{loadError}</span>
          <button className="ghost" onClick={() => void reload()}>Try again</button>
        </div>
      ) : null}

      {!customer?.palmEnrolled ? (
        <Link to="/enroll/intro" className="callout action">
          🖐️ Enroll your palm to start paying at shops →
        </Link>
      ) : (
        <div className="palm-chip">🖐️ Palm ready — wave to pay at any Palm Wallet counter</div>
      )}

      <button className="primary" onClick={() => setSheetOpen(true)}>
        + Add money
      </button>

      <section>
        <header className="row-head">
          <h3>Recent</h3>
          <Link to="/history" className="linklike">
            See all
          </Link>
        </header>
        {recent.length === 0 ? (
          <p className="muted center">No transactions yet — top up to get started.</p>
        ) : (
          <ul className="txn-list">
            {recent.map((t) => (
              <TxnRow key={t.id} txn={t} />
            ))}
          </ul>
        )}
      </section>

      {sheetOpen ? (
        <DepositSheet
          onClose={() => setSheetOpen(false)}
          onDone={(w) => {
            setWallet(w);
            void reload();
          }}
        />
      ) : null}
    </div>
  );
}

export function TxnRow({ txn }: { txn: TransactionDTO }): JSX.Element {
  const signed = txn.signedAmountPiasters ?? txn.amountPiasters;
  const positive = signed > 0;
  return (
    <li>
      <Link to={`/receipt/${txn.ref}`} state={{ txn }} className="txn-row">
        <span className={`txn-icon ${txn.type}`}>
          {txn.type === 'deposit' ? '＋' : txn.type === 'refund' ? '↩' : '🛍'}
        </span>
        <span className="grow">
          <strong>{labelFor(txn)}</strong>
          <small className="muted">{new Date(txn.createdAt).toLocaleString('en-EG')}</small>
        </span>
        <span className={positive ? 'amount plus' : 'amount minus'}>
          {positive ? '+' : '−'} {formatEGP(Math.abs(signed))}
        </span>
      </Link>
    </li>
  );
}

function labelFor(t: TransactionDTO): string {
  if (t.type === 'deposit') return `Top-up · ${t.provider?.replace('_sim', '') ?? 'wallet'}`;
  if (t.type === 'refund') return `Refund${t.counterparty ? ` · ${t.counterparty.displayName}` : ''}`;
  return t.counterparty?.displayName ?? 'Payment';
}

const PROVIDERS: Array<{ id: DepositSource; name: string; note: string }> = [
  { id: 'instapay_sim', name: 'InstaPay', note: 'SIMULATED adapter' },
  { id: 'vodafone_cash_sim', name: 'Vodafone Cash', note: 'SIMULATED adapter' }
];

function DepositSheet({ onClose, onDone }: { onClose(): void; onDone(w: WalletDTO): void }): JSX.Element {
  const [amount, setAmount] = useState('');
  const [source, setSource] = useState<DepositSource>('instapay_sim');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<WalletDTO | null>(null);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    let piasters: number;
    try {
      piasters = toPiasters(amount || '');
    } catch {
      return setError('Enter an amount like 25 or 25.50');
    }
    try {
      setBusy(true);
      // requestId+timestamp power replay protection — fresh per attempt.
      const d = await api.deposit(crypto.randomUUID(), new Date().toISOString(), piasters, source);
      setDone(d.wallet);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Top-up failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        {done ? (
          <>
            <div className="big-icon success">✅</div>
            <h3>Money added</h3>
            <p className="balance">{done.formatted ?? formatEGP(done.balancePiasters)}</p>
            <button className="primary" onClick={() => onDone(done)}>
              Done
            </button>
          </>
        ) : (
          <form onSubmit={(e) => void submit(e)}>
            <h3>Add money</h3>
            <p className="muted small">Simulated top-up — no real bank is contacted.</p>

            <label>
              Amount (EGP)
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                placeholder="e.g. 100"
                inputMode="decimal"
                autoFocus
              />
              <small>
                Min {(MIN_DEPOSIT_PIASTERS / 100).toFixed(0)} · Max {(MAX_DEPOSIT_PIASTERS / 100).toLocaleString('en-EG')} EGP
              </small>
            </label>

            <fieldset className="providers">
              <legend>From</legend>
              {PROVIDERS.map((p) => (
                <label key={p.id} className={`provider ${source === p.id ? 'active' : ''}`}>
                  <input
                    type="radio"
                    name="provider"
                    checked={source === p.id}
                    onChange={() => setSource(p.id)}
                  />
                  <span>
                    <strong>{p.name}</strong>
                    <small>{p.note}</small>
                  </span>
                </label>
              ))}
            </fieldset>

            {error ? <div className="callout warn">{error}</div> : null}

            <button className="primary" disabled={busy}>
              {busy ? 'Contacting provider…' : 'Add money'}
            </button>
            <button type="button" className="ghost" onClick={onClose}>
              Cancel
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
