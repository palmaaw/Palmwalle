/**
 * The till: takings → amount keypad → scan screen → result. Retry preserves
 * the entered amount; every attempt gets a FRESH requestId + timestamp so the
 * server's replay protection can distinguish a retry from a duplicate charge.
 *
 * IDENTITY-BLIND: the till never chooses who is paying — it scans whatever
 * palm is presented and the server identifies it against enrolled templates.
 * The customer's name appears only in the outcome, like a real payment.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { formatEGP } from '@palmwallet/shared';

import { api, ApiError } from '../api.js';
import type { TransactionDTO, WalletDTO } from '../api.js';
import { usePalmReader, usePos } from '../state.js';

export function Pos(): JSX.Element {
  const { merchant, signOut } = usePos();
  const navigate = useNavigate();
  const [wallet, setWallet] = useState<WalletDTO | null>(null);
  const [today, setToday] = useState(0);
  const [recent, setRecent] = useState<TransactionDTO[]>([]);
  const [chargeOpen, setChargeOpen] = useState(false);

  const reload = useCallback(async () => {
    try {
      const [w, t] = await Promise.all([api.wallet(), api.transactions(undefined, 8)]);
      setWallet(w.wallet);
      setRecent(t.items);
      setToday(
        t.items
          .filter((x) => x.type === 'payment' && x.status === 'completed' && sameDay(x.createdAt))
          .reduce((s, x) => s + (x.signedAmountPiasters ?? x.amountPiasters ?? 0), 0)
      );
    } catch {
      /* keep last-known */
    }
  }, []);

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load once
  }, []);

  if (!merchant) return <div className="screen muted">Loading till…</div>;

  return (
    <div className="screen">
      <header className="pos-head">
        <div>
          <h2>{merchant.name}</h2>
          <span className="muted mono">{merchant.code}</span>
        </div>
        <button className="linklike" onClick={() => { signOut(); navigate('/', { replace: true }); }}>
          Close till
        </button>
      </header>

      <div className="takings">
        <div>
          <span className="muted">Today</span>
          <strong>{formatEGP(today)}</strong>
        </div>
        <div>
          <span className="muted">Settled balance</span>
          <strong>{wallet ? wallet.formatted ?? formatEGP(wallet.balancePiasters) : '…'}</strong>
        </div>
      </div>

      <button className="primary big" onClick={() => setChargeOpen(true)}>
        ⚡ CHARGE — scan a palm
      </button>

      <section>
        <header className="row-head">
          <h3>Latest activity</h3>
          <button className="linklike" onClick={() => navigate('/history')}>
            All transactions
          </button>
        </header>
        {recent.length === 0 ? (
          <p className="muted center">No sales yet today.</p>
        ) : (
          <ul className="txn-list">
            {recent.map((t) => (
              <li key={t.id}>
                <div className="txn-row static">
                  <span className={`txn-icon ${t.type}`}>{t.type === 'payment' ? '🛍' : t.type === 'refund' ? '↩' : '＋'}</span>
                  <span className="grow">
                    <strong>{t.counterparty?.displayName ?? labelFor(t)}</strong>
                    <small className="muted">{new Date(t.createdAt).toLocaleTimeString('en-EG')} · {t.ref}</small>
                  </span>
                  <span className={t.type === 'refund' ? 'amount minus' : 'amount plus'}>
                    {(t.signedAmountPiasters ?? t.amountPiasters ?? 0) >= 0 ? '+' : '−'} {formatEGP(Math.abs(t.signedAmountPiasters ?? t.amountPiasters ?? 0))}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {chargeOpen ? <ChargeFlow onDone={() => void reload()} onClose={() => setChargeOpen(false)} /> : null}
    </div>
  );
}

function labelFor(t: TransactionDTO): string {
  return t.type === 'deposit' ? 'Float top-up' : t.type === 'refund' ? 'Refund issued' : 'Payment';
}

function sameDay(iso: string): boolean {
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

// ---------------------------------------------------------------------------
// Charge flow: keypad → scan → result (state machine inside one modal screen).
// ---------------------------------------------------------------------------

type Flow = 'keypad' | 'scan' | 'result';

function ChargeFlow({ onClose, onDone }: { onClose(): void; onDone(): void }): JSX.Element {
  const [flow, setFlow] = useState<Flow>('keypad');
  const [digits, setDigits] = useState('');
  const [outcome, setOutcome] = useState<{ ok: boolean; heading: string; detail: string; ref?: string } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [demoSlug, setDemoSlug] = useState<'aya' | 'omar' | 'nour' | null>(null);
  const reader = usePalmReader(flow === 'scan');

  /** digits are whole pounds; piasters = ×100. */
  const piasters = Number(digits || '0') * 100;
  const display = formatEGP(piasters);

  function press(k: string): void {
    if (k === 'del') return setDigits((d) => d.slice(0, -1));
    if (k === 'clear') return setDigits('');
    setDigits((d) => (d === '0' ? k : (d + k).slice(0, 7)));
  }

  async function scan(): Promise<void> {
    if (!reader) return;
    setScanning(true);
    // Simulated scanner latency for UX realism.
    await new Promise((r) => setTimeout(r, 550));
    try {
      const probe = demoSlug ? reader.readDemo(demoSlug) : await reader.read();
      if (!probe) {
        setOutcome({ ok: false, heading: 'No palm detected', detail: 'Place the customer’s open palm inside the camera frame and try again.' });
        setFlow('result');
        return;
      }
      const r = await api.authorize(piasters, probe);
      if (r.kind === 'completed') {
        setOutcome({
          ok: true,
          heading: `${r.customerName} paid ${formatEGP(r.amountPiasters)}`,
          detail: `New wallet balance ${r.customerBalanceFormatted}`,
          ref: r.ref
        });
      } else {
        setOutcome({
          ok: false,
          heading:
            r.code === 'BIOMETRIC_NO_MATCH'
              ? 'Palm not recognised'
              : r.code === 'BIOMETRIC_AMBIGUOUS_MATCH'
                ? 'Ambiguous match — ask for another scan'
                : r.code === 'INSUFFICIENT_FUNDS'
                  ? 'Customer has insufficient funds'
                  : 'Payment declined',
          detail: r.message
        });
      }
      setFlow('result');
      onDone();
    } catch (err) {
      setOutcome({
        ok: false,
        heading: err instanceof ApiError && err.code === 'REQUEST_STALE' ? 'Scan expired' : 'Payment error',
        detail: err instanceof ApiError ? err.message : 'Something went wrong'
      });
      setFlow('result');
    } finally {
      setScanning(false);
    }
  }

  async function refund(ref: string): Promise<void> {
    try {
      await api.refund(ref, 'POS-initiated refund');
      setOutcome((o) => (o ? { ...o, ok: false, heading: 'Refunded', detail: `${formatEGP(piasters)} returned to the customer` } : o));
      onDone();
    } catch (err) {
      setOutcome((o) =>
        o ? { ...o, detail: `Refund failed: ${err instanceof ApiError ? err.message : 'error'}` } : o
      );
    }
  }

  return (
    <div className="sheet-backdrop">
      <div className="sheet pos-sheet">
        {flow === 'keypad' ? (
          <>
            <header className="row-head">
              <h3>Charge amount</h3>
              <button className="linklike" onClick={onClose}>
                Cancel
              </button>
            </header>
            <div className="amount-display">{display}</div>
            <Keypad onKey={press} />
            <button className="primary big" disabled={piasters <= 0} onClick={() => setFlow('scan')}>
              Scan customer palm →
            </button>
          </>
        ) : null}

        {flow === 'scan' ? (
          <>
            <div className="scan-amount">{display}</div>
            <div className={`scanner ${scanning ? 'busy' : ''}`}>
              {reader?.cameraReady ? <><video ref={reader.videoRef} className="scanner-video" muted playsInline /><div className="scanner-guide">Place open palm here</div></> : <div className="palm-glyph" aria-hidden>🖐️</div>}
              {scanning ? <div className="scanline" /> : null}
            </div>
            <p className="muted center small">
              {!reader
                ? 'Reader initialising…'
                : reader.cameraReady
                  ? scanning ? 'Matching this palm against enrolled customers…' : 'Hold the customer’s palm over the camera'
                : scanning
                  ? 'Matching against enrolled customers…'
                  : 'Ask the customer to hold their palm over the reader'}
            </p>
            {!scanning ? (
              <>
                <button className="primary big" disabled={!reader || !reader.cameraReady} onClick={() => void scan()}>
                  🖐 Scan palm
                </button>
                <p className="muted center small">The till never sees names — the server identifies the palm itself.</p>
                <div className="demo-reader" aria-label="Investor demo reader">
                  <span className="muted small">Demo reader (for seeded accounts)</span>
                  {(['aya', 'omar', 'nour'] as const).map((slug) => <button key={slug} className={demoSlug === slug ? 'selected' : ''} onClick={() => setDemoSlug(slug)}>{slug === 'aya' ? 'Aya' : slug === 'omar' ? 'Omar' : 'Nour'}</button>)}
                  {demoSlug ? <button className="ghost" onClick={() => setDemoSlug(null)}>Use camera</button> : null}
                </div>
                <button className="ghost" onClick={() => setFlow('keypad')}>
                  ← Wrong amount
                </button>
              </>
            ) : null}
          </>
        ) : null}

        {flow === 'result' && outcome ? (
          <div className={`result ${outcome.ok ? 'good' : 'bad'}`}>
            <div className="big-icon">{outcome.ok ? '✅' : outcome.heading.includes('insufficient') ? '🚫' : '✋'}</div>
            <h3>{outcome.heading}</h3>
            <p className="detail">{outcome.detail}</p>
            {outcome.ref ? <p className="mono muted small">ref {outcome.ref}</p> : null}
            <div className="result-actions">
              {outcome.ok && outcome.ref ? (
                <button className="ghost" onClick={() => void refund(outcome.ref!)}>
                  Issue refund
                </button>
              ) : null}
              <button
                className="primary"
                onClick={() => {
                  setOutcome(null);
                  setFlow('scan'); // retry keeps the amount, new requestId per attempt
                }}
              >
                {outcome.ok ? 'Next customer' : 'Try again'}
              </button>
              <button
                className="ghost"
                onClick={() => {
                  setDigits('');
                  onClose();
                }}
              >
                Done
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'del'];

function Keypad({ onKey }: { onKey(k: string): void }): JSX.Element {
  return (
    <div className="keypad">
      {KEYS.map((k) => (
        <button key={k} onClick={() => onKey(k)}>
          {k === 'del' ? '⌫' : k === 'clear' ? 'C' : k}
        </button>
      ))}
    </div>
  );
}
