/**
 * @palma/db — SQLite persistence for PalmPay (PROTOTYPE).
 * Node-only (node:sqlite); the browser packages never import this.
 */

export { PalmaDatabase, nowIso } from './database.js';
export { runMigrations, sha256Hex } from './migrator.js';
export type { AppliedMigration } from './migrator.js';

export type {
  AuditRow,
  CustomerRow,
  IdempotencyRow,
  LedgerEntryRow,
  MerchantRow,
  OwnerType,
  TemplateRow,
  TransactionRow,
  TxnStatus,
  TxnType,
  WalletAccountRow
} from './rows.js';

export { CustomerRepo, MerchantRepo } from './repos/customers.js';
export { AccountRepo } from './repos/accounts.js';
export { SqliteTemplateStore } from './repos/templates.js';
export { TransactionRepo, encodeCursor } from './repos/transactions.js';
export type { NewTransaction, TxnPage } from './repos/transactions.js';
export { LedgerRepo } from './repos/ledger.js';
export type { LedgerLeg } from './repos/ledger.js';
export { IdempotencyRepo } from './repos/idempotency.js';
export { AuditRepo } from './repos/audit.js';
export type { AuditAppendInput, ChainVerification } from './repos/audit.js';

export { assertInvariants, collectInvariants } from './invariants.js';
export type { InvariantCheck, InvariantReport } from './invariants.js';
