/**
 * Double-entry posting. Balances NEVER change through UPDATE statements from
 * application code — inserting a ledger entry fires the ledger_apply_debit /
 * _credit triggers, which move wallet_accounts.balance inside the same
 * transaction. Overdrafts therefore abort at the SQL layer (balance CHECK >= 0),
 * rolling back everything posted in the surrounding BEGIN IMMEDIATE block.
 */

import { newId } from '@palmwallet/shared';
import { nowIso, PalmWalletDatabase } from '../database.js';
import type { LedgerEntryRow } from '../rows.js';

export interface LedgerLeg {
  accountId: string;
  direction: 'debit' | 'credit';
  amountPiasters: number;
  memo?: string;
}

const COLS =
  'seq, entry_id AS entryId, transaction_id AS transactionId, entry_index AS entryIndex, ' +
  'account_id AS accountId, direction, amount_piasters AS amountPiasters, ' +
  'balance_after AS balanceAfter, memo, created_at AS createdAt';

export class LedgerRepo {
  constructor(private readonly db: PalmWalletDatabase) {}

  entriesForTransaction(transactionId: string): LedgerEntryRow[] {
    return this.db
      .stmt(`SELECT ${COLS} FROM ledger_entries WHERE transaction_id = ? ORDER BY entry_index`)
      .all(transactionId) as unknown as LedgerEntryRow[];
  }

  entriesForAccount(accountId: string, limit = 50): LedgerEntryRow[] {
    return this.db
      .stmt(`SELECT ${COLS} FROM ledger_entries WHERE account_id = ? ORDER BY seq DESC LIMIT ?`)
      .all(accountId, limit) as unknown as LedgerEntryRow[];
  }

  /**
   * Post all legs of one transaction. MUST run inside a withTransaction block
   * together with the transactions-row INSERT so a failure anywhere rolls back
   * everything. Throws unless total debits == total credits.
   */
  post(transactionId: string, legs: LedgerLeg[]): void {
    if (legs.length < 2) throw new Error('a double-entry posting needs at least two legs');

    let debits = 0;
    let credits = 0;
    for (const leg of legs) {
      if (!Number.isInteger(leg.amountPiasters) || leg.amountPiasters <= 0) {
        throw new Error(`ledger amounts must be positive integers, got ${leg.amountPiasters}`);
      }
      if (leg.direction === 'debit') debits += leg.amountPiasters;
      else credits += leg.amountPiasters;
    }
    if (debits !== credits) {
      throw new Error(`unbalanced posting for ${transactionId}: debits=${debits} credits=${credits}`);
    }

    const createdAt = nowIso();
    const existing = this.db
      .stmt('SELECT COUNT(*) AS n FROM ledger_entries WHERE transaction_id = ?')
      .get(transactionId) as { n: number };
    let index = Number(existing.n);

    for (const leg of legs) {
      const account = this.db
        .stmt('SELECT balance_piasters AS b FROM wallet_accounts WHERE id = ?')
        .get(leg.accountId) as { b: number } | undefined;
      if (!account) throw new Error(`wallet account not found: ${leg.accountId}`);
      // The value we record AND the value the trigger applies are computed from
      // the same read; both happen inside BEGIN IMMEDIATE so no other writer can
      // slip between them.
      const delta = leg.direction === 'debit' ? -leg.amountPiasters : leg.amountPiasters;
      const balanceAfter = Number(account.b) + delta;
      this.db
        .stmt(
          `INSERT INTO ledger_entries
             (entry_id, transaction_id, entry_index, account_id, direction, amount_piasters, balance_after, memo, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          newId(),
          transactionId,
          index,
          leg.accountId,
          leg.direction,
          leg.amountPiasters,
          balanceAfter,
          leg.memo ?? '',
          createdAt
        );
      index++;
    }
  }
}
