/**
 * ⚠️ SIMULATED WALLET LEDGER — no real financial rails.
 *
 * Every movement is a balanced double-entry posting written in ONE synchronous
 * SQLite transaction (BEGIN IMMEDIATE): transaction row + ledger legs + status
 * flip + audit event commit or roll back together. Balances move exclusively via
 * the ledger's AFTER INSERT triggers; overdrafts abort at the SQL CHECK layer
 * even if a pre-check were ever wrong.
 *
 * Future InstaPay/Vodafone Cash integration plugs in at the provider-adapter and
 * this service's boundaries — nothing else changes.
 */

import { ApiError, newHumanRef, newId } from '@palma/shared';
import type { CustomerRow, LedgerEntryRow, MerchantRow, PalmaDatabase, TransactionRow, WalletAccountRow } from '@palma/db';
import { AccountRepo, AuditRepo, LedgerRepo, TransactionRepo } from '@palma/db';

export const SYSTEM_TOPUP_SOURCE = 'topup_source';

export interface DepositInput {
  customer: CustomerRow;
  customerAccount: WalletAccountRow;
  amountPiasters: number;
  source: string;
  requestId: string;
  providerRef: string;
}

export interface PayInput {
  amountPiasters: number;
  customer: CustomerRow;
  customerAccount: WalletAccountRow;
  merchant: MerchantRow;
  merchantAccount: WalletAccountRow;
  requestId?: string | null;
  matchScore?: number | null;
}

export interface RefundInput {
  parent: TransactionRow;
  merchant: MerchantRow;
  reason?: string;
  requestId?: string | null;
}

export class LedgerService {
  constructor(private readonly db: PalmaDatabase) {}

  accounts(): AccountRepo {
    return new AccountRepo(this.db);
  }

  txns(): TransactionRepo {
    return new TransactionRepo(this.db);
  }

  entries(): LedgerRepo {
    return new LedgerRepo(this.db);
  }

  audit(): AuditRepo {
    return new AuditRepo(this.db);
  }

  /** Simulated top-up: debit system float, credit the customer. */
  deposit(x: DepositInput): TransactionRow {
    return this.db.withTransaction(() => {
      const sysAccount = this.accounts().ensureForOwner({ ownerType: 'system', ownerId: SYSTEM_TOPUP_SOURCE });
      const id = newId();
      this.txns().insert({
        id,
        humanRef: newHumanRef('DP'),
        type: 'deposit',
        amountPiasters: x.amountPiasters,
        customerAccountId: x.customerAccount.id,
        provider: x.source,
        providerRef: x.providerRef,
        requestId: x.requestId,
        metaJson: '{}'
      });
      this.entries().post(id, [
        { accountId: sysAccount.id, direction: 'debit', amountPiasters: x.amountPiasters, memo: `topup via ${x.source}` },
        { accountId: x.customerAccount.id, direction: 'credit', amountPiasters: x.amountPiasters, memo: `topup via ${x.source}` }
      ]);
      this.txns().updateStatus(id, 'completed');
      const txn = this.txns().getById(id)!;
      this.audit().append({
        actorType: 'customer',
        actorId: x.customer.id,
        event: 'wallet.deposit',
        subjectType: 'customer',
        subjectId: x.customer.id,
        outcome: 'ok',
        data: { ref: txn.humanRef, amountPiasters: x.amountPiasters, source: x.source }
      });
      return txn;
    });
  }

  /** Scan & pay settlement: debit customer, credit merchant — atomically. */
  pay(x: PayInput): TransactionRow {
    return this.db.withTransaction(() => {
      // Re-check state INSIDE the write lock (BEGIN IMMEDIATE makes this sound).
      if (x.customer.status !== 'active') throw new ApiError('ACCOUNT_DISABLED', 'Customer account is disabled');
      if (x.merchant.status !== 'active') throw new ApiError('ACCOUNT_DISABLED', 'Merchant account is disabled');
      const custAcc = this.accounts().getById(x.customerAccount.id)!;
      if (!custAcc || custAcc.status !== 'active') throw new ApiError('ACCOUNT_DISABLED', 'Customer wallet is not active');
      if (custAcc.balancePiasters < x.amountPiasters) {
        throw new ApiError('INSUFFICIENT_FUNDS', 'Customer wallet balance is too low for this payment');
      }
      const merchAcc = this.accounts().getById(x.merchantAccount.id)!;
      if (!merchAcc || merchAcc.status !== 'active') throw new ApiError('ACCOUNT_DISABLED', 'Merchant wallet is not active');

      const id = newId();
      this.txns().insert({
        id,
        humanRef: newHumanRef('PM'),
        type: 'payment',
        amountPiasters: x.amountPiasters,
        customerAccountId: x.customerAccount.id,
        merchantAccountId: x.merchantAccount.id,
        requestId: x.requestId ?? null,
        metaJson: JSON.stringify({ matchScore: x.matchScore ?? null })
      });
      this.entries().post(id, [
        { accountId: x.customerAccount.id, direction: 'debit', amountPiasters: x.amountPiasters, memo: `payment to ${x.merchant.code}` },
        { accountId: x.merchantAccount.id, direction: 'credit', amountPiasters: x.amountPiasters, memo: `payment from ${x.customer.name}` }
      ]);
      this.txns().updateStatus(id, 'completed');
      const txn = this.txns().getById(id)!;
      this.audit().append({
        actorType: 'merchant',
        actorId: x.merchant.id,
        event: 'payment.authorized',
        subjectType: 'customer',
        subjectId: x.customer.id,
        outcome: 'ok',
        data: {
          ref: txn.humanRef,
          amountPiasters: x.amountPiasters,
          score: x.matchScore ?? null
          // NOTE: never features/descriptors — scores and references only.
        }
      });
      return txn;
    });
  }

  /** Full-and-once refund of a completed payment, initiated by its merchant. */
  refund(x: RefundInput): TransactionRow {
    return this.db.withTransaction(() => {
      const parent = this.txns().getById(x.parent.id);
      if (!parent) throw new ApiError('NOT_FOUND', 'Payment not found');
      if (parent.type !== 'payment') throw new ApiError('REFUND_NOT_ALLOWED', 'Only payments can be refunded');
      const merchAcc = this.accounts().getByOwner('merchant', x.merchant.id);
      if (!parent.merchantAccountId || !merchAcc || parent.merchantAccountId !== merchAcc.id) {
        throw new ApiError('FORBIDDEN', 'This payment does not belong to your shop');
      }
      if (parent.status !== 'completed') {
        throw new ApiError('REFUND_NOT_ALLOWED', `A ${parent.status} payment cannot be refunded`);
      }
      const existing = this.db
        .stmt("SELECT COUNT(*) AS n FROM transactions WHERE parent_transaction_id = ? AND type = 'refund' AND status != 'failed'")
        .get(parent.id) as { n: number };
      if (Number(existing.n) > 0) throw new ApiError('REFUND_NOT_ALLOWED', 'This payment was already refunded');

      const merchantAccount = this.accounts().getById(parent.merchantAccountId)!;
      const customerAccount = this.accounts().getById(parent.customerAccountId!)!;
      if (merchantAccount.balancePiasters < parent.amountPiasters) {
        throw new ApiError('INSUFFICIENT_FUNDS', 'Merchant balance is too low to refund this payment');
      }

      const id = newId();
      this.txns().insert({
        id,
        humanRef: newHumanRef('RF'),
        type: 'refund',
        amountPiasters: parent.amountPiasters,
        customerAccountId: parent.customerAccountId,
        merchantAccountId: parent.merchantAccountId,
        parentTransactionId: parent.id,
        requestId: x.requestId ?? null,
        metaJson: JSON.stringify({ reason: x.reason ?? null })
      });
      this.entries().post(id, [
        { accountId: merchantAccount.id, direction: 'debit', amountPiasters: parent.amountPiasters, memo: `refund of ${parent.humanRef}` },
        { accountId: customerAccount.id, direction: 'credit', amountPiasters: parent.amountPiasters, memo: `refund of ${parent.humanRef}` }
      ]);
      this.txns().updateStatus(id, 'completed');
      const txn = this.txns().getById(id)!;
      this.audit().append({
        actorType: 'merchant',
        actorId: x.merchant.id,
        event: 'payment.refunded',
        subjectType: 'transaction',
        subjectId: parent.id,
        outcome: 'ok',
        data: { ref: txn.humanRef, parentRef: parent.humanRef, amountPiasters: parent.amountPiasters }
      });
      return txn;
    });
  }

  /** Persist a FAILED provider top-up attempt (audit trail; no ledger movement). */
  recordFailedDeposit(x: { customer: { id: string }; amountPiasters: number; source: string; requestId: string; failureCode: string }): void {
    this.db.withTransaction(() => {
      const id = newId();
      this.txns().insert({
        id,
        humanRef: newHumanRef('DP'),
        type: 'deposit',
        amountPiasters: x.amountPiasters,
        provider: x.source,
        requestId: x.requestId
      });
      this.txns().updateStatus(id, 'failed', { failureCode: x.failureCode });
      this.audit().append({
        actorType: 'customer',
        actorId: x.customer.id,
        event: 'wallet.deposit_failed',
        subjectType: 'customer',
        subjectId: x.customer.id,
        outcome: 'error',
        data: { source: x.source, amountPiasters: x.amountPiasters, code: x.failureCode }
      });
    });
  }

  /** Entries behind a transaction — used by receipts. */
  entriesFor(transactionId: string): LedgerEntryRow[] {
    return this.entries().entriesForTransaction(transactionId);
  }
}
