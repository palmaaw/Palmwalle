import { nowIso, PalmaDatabase } from '../database.js';
import type { TransactionRow, TxnStatus } from '../rows.js';

const COLS =
  'id, human_ref AS humanRef, type, status, amount_piasters AS amountPiasters, currency, ' +
  'customer_account_id AS customerAccountId, merchant_account_id AS merchantAccountId, ' +
  'parent_transaction_id AS parentTransactionId, provider, provider_ref AS providerRef, ' +
  'request_id AS requestId, meta_json AS metaJson, failure_code AS failureCode, ' +
  'created_at AS createdAt, settled_at AS settledAt';

export interface NewTransaction {
  id: string;
  humanRef: string;
  type: TransactionRow['type'];
  amountPiasters: number;
  customerAccountId?: string | null;
  merchantAccountId?: string | null;
  parentTransactionId?: string | null;
  provider?: string | null;
  providerRef?: string | null;
  requestId?: string | null;
  metaJson?: string;
}

/** Opaque keyset-paging cursor for history lists. */
export function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const idx = raw.indexOf('|');
    if (idx <= 0) return null;
    return { createdAt: raw.slice(0, idx), id: raw.slice(idx + 1) };
  } catch {
    return null;
  }
}

export interface TxnPage {
  items: TransactionRow[];
  nextCursor: string | null;
}

export class TransactionRepo {
  constructor(private readonly db: PalmaDatabase) {}

  insert(t: NewTransaction): void {
    this.db
      .stmt(
        `INSERT INTO transactions
           (id, human_ref, type, status, amount_piasters, currency,
            customer_account_id, merchant_account_id, parent_transaction_id,
            provider, provider_ref, request_id, meta_json, failure_code, created_at, settled_at)
         VALUES (?, ?, ?, 'pending', ?, 'EGP', ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`
      )
      .run(
        t.id,
        t.humanRef,
        t.type,
        t.amountPiasters,
        t.customerAccountId ?? null,
        t.merchantAccountId ?? null,
        t.parentTransactionId ?? null,
        t.provider ?? null,
        t.providerRef ?? null,
        t.requestId ?? null,
        t.metaJson ?? '{}',
        nowIso()
      );
  }

  private mapGet(sql: string, ...params: Array<string>): TransactionRow | null {
    return (this.db.stmt(sql).get(...params) ?? null) as TransactionRow | null;
  }

  getById(id: string): TransactionRow | null {
    return this.mapGet(`SELECT ${COLS} FROM transactions WHERE id = ?`, id);
  }

  getByRef(humanRef: string): TransactionRow | null {
    return this.mapGet(`SELECT ${COLS} FROM transactions WHERE human_ref = ?`, humanRef);
  }

  getByRequestId(requestId: string): TransactionRow | null {
    return this.mapGet(`SELECT ${COLS} FROM transactions WHERE request_id = ?`, requestId);
  }

  /** Only pending -> completed|failed and completed -> reversed are legal; the
   *  txn_status_transition trigger enforces the same machine in SQL. */
  updateStatus(id: string, status: TxnStatus, opts: { failureCode?: string } = {}): void {
    if (status === 'completed' || status === 'reversed') {
      this.db.stmt('UPDATE transactions SET status = ?, settled_at = ? WHERE id = ?').run(status, nowIso(), id);
    } else if (status === 'failed') {
      this.db.stmt('UPDATE transactions SET status = ?, failure_code = ? WHERE id = ?').run(status, opts.failureCode ?? null, id);
    } else {
      throw new Error(`updateStatus cannot move a transaction back to ${status}`);
    }
  }

  /**
   * History for one wallet account (either side), newest first, keyset-paged.
   * Cursor is opaque; pass nextCursor back verbatim.
   */
  listByAccount(accountId: string, opts: { limit?: number; cursor?: string | null } = {}): TxnPage {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
    if (opts.cursor && !cur) throw new Error('malformed pagination cursor');

    const rows = (
      cur
        ? this.db
            .stmt(
              `SELECT ${COLS} FROM transactions
               WHERE (customer_account_id = ? OR merchant_account_id = ?)
                 AND (created_at < ? OR (created_at = ? AND id < ?))
               ORDER BY created_at DESC, id DESC LIMIT ?`
            )
            .all(accountId, accountId, cur.createdAt, cur.createdAt, cur.id, limit + 1)
        : this.db
            .stmt(
              `SELECT ${COLS} FROM transactions
               WHERE customer_account_id = ? OR merchant_account_id = ?
               ORDER BY created_at DESC, id DESC LIMIT ?`
            )
            .all(accountId, accountId, limit + 1)
    ) as unknown as TransactionRow[];

    let nextCursor: string | null = null;
    if (rows.length > limit) {
      rows.pop();
      const last = rows[rows.length - 1]!;
      nextCursor = encodeCursor(last.createdAt, last.id);
    }
    return { items: rows, nextCursor };
  }
}
