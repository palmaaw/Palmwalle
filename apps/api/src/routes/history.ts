/**
 * Shared transaction-history mapping for both apps' /me/transactions routes:
 * counterparty resolution, parent-ref resolution, sign convention.
 */

import type { MaskedParty, TransactionDTO } from '@palma/shared';
import type { TransactionRow } from '@palma/db';
import type { AppContext } from '../container.js';
import { maskPhone, transactionDTO } from '../dto.js';

export function mapHistory(
  ctx: AppContext,
  rows: TransactionRow[],
  viewerAccountId: string
): TransactionDTO[] {
  const parentRefs = new Map<string, string>();
  for (const r of rows) {
    if (!r.parentTransactionId || parentRefs.has(r.parentTransactionId)) continue;
    const parent = ctx.repos.txns.getById(r.parentTransactionId);
    if (parent) parentRefs.set(parent.id, parent.humanRef);
  }
  return rows.map((row) =>
    transactionDTO(row, {
      viewerAccountId,
      counterpartyFor: (r) => counterpartyOf(ctx, r, viewerAccountId),
      parentRefFor: (r) => parentRefs.get(r.parentTransactionId ?? '') ?? null
    })
  );
}

function counterpartyOf(ctx: AppContext, row: TransactionRow, viewerAccountId: string): MaskedParty | null {
  if (viewerAccountId === row.customerAccountId && row.merchantAccountId) {
    // Viewer is the customer; show the shop.
    const acc = ctx.repos.accounts.getById(row.merchantAccountId);
    const m = acc ? ctx.repos.merchants.getById(acc.ownerId) : null;
    return m ? { displayName: m.name, maskedPhone: maskPhone(m.phone) } : null;
  }
  if (viewerAccountId === row.merchantAccountId && row.customerAccountId) {
    // Viewer is the merchant; show the payer.
    const acc = ctx.repos.accounts.getById(row.customerAccountId);
    const c = acc ? ctx.repos.customers.getById(acc.ownerId) : null;
    return c ? { displayName: c.name, maskedPhone: maskPhone(c.phone) } : null;
  }
  return null;
}
