/**
 * Transaction history (keyset-paged) + receipt view.
 */

import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';

import { formatEGP } from '@palmwallet/shared';

import { api } from '../api.js';
import type { TransactionDTO } from '../api.js';
import { TxnRow } from './Home.js';

export function History(): JSX.Element {
  const [items, setItems] = useState<TransactionDTO[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(next: boolean): Promise<void> {
    try {
      const d = await api.transactions(next ? cursor ?? undefined : undefined, 20);
      setItems((prev) => (next ? [...prev, ...d.items] : d.items));
      setCursor(d.nextCursor);
      setLoading(false);
    } catch {
      setError('Could not load your history');
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- first page only
  }, []);

  return (
    <div className="screen">
      <h2>Transactions</h2>
      {loading && items.length === 0 ? <p className="muted center">Loading…</p> : null}
      {error ? <div className="callout warn">{error}</div> : null}
      {!loading && items.length === 0 ? (
        <p className="muted center">Nothing here yet.</p>
      ) : (
        <ul className="txn-list">
          {items.map((t) => (
            <TxnRow key={t.id} txn={t} />
          ))}
        </ul>
      )}
      {cursor ? (
        <button className="ghost" onClick={() => void load(true)}>
          Load more
        </button>
      ) : null}
    </div>
  );
}

export function Receipt(): JSX.Element {
  const { ref } = useParams<{ ref: string }>();
  const location = useLocation();
  const [txn, setTxn] = useState<TransactionDTO | null>((location.state as { txn?: TransactionDTO } | null)?.txn ?? null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (txn) return;
    // Deep-link without state: walk a few pages to find the ref.
    let cursor: string | undefined;
    void (async () => {
      for (let i = 0; i < 5; i++) {
        const d = await api.transactions(cursor, 50).catch(() => null);
        if (!d) break;
        const hit = d.items.find((t) => t.ref === ref);
        if (hit) return setTxn(hit);
        cursor = d.nextCursor ?? undefined;
        if (!cursor) break;
      }
      setMissing(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lookup on mount
  }, []);

  if (missing) {
    return (
      <div className="screen">
        <p className="callout warn">Transaction {ref} not found in recent history.</p>
        <Link to="/history" className="primary as-button">
          Back
        </Link>
      </div>
    );
  }
  if (!txn) return <div className="screen center-screen muted">Loading…</div>;

  return (
    <div className="screen center-screen">
      <div className={`receipt ${txn.status === 'completed' ? 'good' : txn.status === 'failed' ? 'bad' : ''}`}>
        <div className="receipt-type">{label(txn)}</div>
        <strong className="receipt-amount">
          {(txn.signedAmountPiasters ?? txn.amountPiasters) > 0 ? '+' : '−'}{' '}
          {formatEGP(Math.abs(txn.signedAmountPiasters ?? txn.amountPiasters))}
        </strong>
        <span className={`status-pill ${txn.status}`}>{txn.status}</span>

        <dl>
          <div>
            <dt>Reference</dt>
            <dd className="mono">{txn.ref}</dd>
          </div>
          {txn.counterparty ? (
            <div>
              <dt>{txn.type === 'deposit' ? 'Provider' : 'With'}</dt>
              <dd>
                {txn.counterparty.displayName} · {txn.counterparty.maskedPhone}
              </dd>
            </div>
          ) : null}
          {txn.provider ? (
            <div>
              <dt>Rail</dt>
              <dd>
                {txn.provider} <em>(simulated)</em>
              </dd>
            </div>
          ) : null}
          {txn.parentRef ? (
            <div>
              <dt>Refunds payment</dt>
              <dd className="mono">{txn.parentRef}</dd>
            </div>
          ) : null}
          {txn.failureCode ? (
            <div>
              <dt>Failure</dt>
              <dd className="mono">{txn.failureCode}</dd>
            </div>
          ) : null}
          <div>
            <dt>Date</dt>
            <dd>{new Date(txn.createdAt).toLocaleString('en-EG')}</dd>
          </div>
        </dl>
        <p className="footnote">Simulated ledger — this is a prototype record, not a bank statement.</p>
      </div>
      <Link to="/home" className="primary as-button">
        Done
      </Link>
    </div>
  );
}

function label(t: TransactionDTO): string {
  switch (t.type) {
    case 'deposit':
      return 'Top-up';
    case 'refund':
      return 'Refund received';
    default:
      return `Paid ${t.counterparty?.displayName ?? ''}`;
  }
}
