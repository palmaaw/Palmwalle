/**
 * POS history with paging and one-tap refunds of completed payments.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { formatEGP } from '@palmwallet/shared';

import { api, ApiError } from '../api.js';
import type { TransactionDTO } from '../api.js';

export function History(): JSX.Element {
  const [items, setItems] = useState<TransactionDTO[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [refunding, setRefunding] = useState<TransactionDTO | null>(null);
  const [notice, setNotice] = useState<{ good: boolean; text: string } | null>(null);

  async function load(next: boolean): Promise<void> {
    const d = await api.transactions(next ? cursor ?? undefined : undefined, 20).catch(() => null);
    if (!d) return setNotice({ good: false, text: 'Could not load history' });
    setItems((prev) => (next ? [...prev, ...d.items] : d.items));
    setCursor(d.nextCursor);
  }

  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- first page
  }, []);

  return (
    <div className="screen">
      <header className="row-head">
        <h2>Transactions</h2>
        <Link to="/pos" className="linklike">
          ← Till
        </Link>
      </header>

      {notice ? <div className={`callout ${notice.good ? 'good' : 'warn'}`}>{notice.text}</div> : null}

      <ul className="txn-list">
        {items.map((t) => (
          <li key={t.id}>
            <div className="txn-row static">
              <span className={`txn-icon ${t.type}`}>{t.type === 'payment' ? '🛍' : t.type === 'refund' ? '↩' : '＋'}</span>
              <span className="grow">
                <strong>{t.counterparty?.displayName ?? (t.type === 'deposit' ? 'Float top-up' : t.type)}</strong>
                <small className="muted">
                  {new Date(t.createdAt).toLocaleString('en-EG')} · {t.ref}
                  {t.parentRef ? ` → refunds ${t.parentRef}` : ''}
                </small>
              </span>
              <span className={t.type === 'refund' ? 'amount minus' : 'amount plus'}>
                {(t.signedAmountPiasters ?? 0) >= 0 ? '+' : '−'}{' '}
                {formatEGP(Math.abs(t.signedAmountPiasters ?? t.amountPiasters))}
              </span>
              {t.type === 'payment' && t.status === 'completed' ? (
                <button className="linklike" onClick={() => setRefunding(t)}>
                  Refund
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>

      {cursor ? (
        <button className="ghost" onClick={() => void load(true)}>
          Load more
        </button>
      ) : null}

      {refunding ? (
        <ConfirmRefund
          txn={refunding}
          onClose={() => setRefunding(null)}
          onDone={() => {
            setNotice({ good: true, text: `Refunded ${formatEGP(refunding.amountPiasters)}` });
            void load(false);
          }}
          onFail={(msg) => setNotice({ good: false, text: msg })}
        />
      ) : null}
    </div>
  );
}

function ConfirmRefund({
  txn,
  onClose,
  onDone,
  onFail
}: {
  txn: TransactionDTO;
  onClose(): void;
  onDone(): void;
  onFail(msg: string): void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);

  async function go(): Promise<void> {
    setBusy(true);
    try {
      await api.refund(txn.ref, 'POS-initiated refund');
      onDone();
    } catch (err) {
      onFail(err instanceof ApiError ? err.message : 'Refund failed');
    } finally {
      setBusy(false);
      onClose();
    }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h3>Refund {formatEGP(txn.amountPiasters)}?</h3>
        <p className="muted small">
          Returns the full amount to {txn.counterparty?.displayName ?? 'the customer'} — payments refund once, in full.
        </p>
        <button className="danger solid" disabled={busy} onClick={() => void go()}>
          {busy ? 'Refunding…' : 'Confirm refund'}
        </button>
        <button className="ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
