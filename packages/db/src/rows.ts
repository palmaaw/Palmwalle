/** Persisted row shapes (camelCase views over snake_case columns). */

export type OwnerType = 'customer' | 'merchant' | 'system';
export type TxnType = 'deposit' | 'payment' | 'refund';
export type TxnStatus = 'pending' | 'completed' | 'failed' | 'reversed';

export interface CustomerRow {
  id: string;
  phone: string;
  name: string;
  pinHash: string;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

export interface MerchantRow {
  id: string;
  code: string;
  name: string;
  phone: string;
  pinHash: string;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

export interface WalletAccountRow {
  id: string;
  ownerType: OwnerType;
  ownerId: string;
  kind: string;
  currency: string;
  balancePiasters: number;
  status: 'active' | 'frozen';
  createdAt: string;
  updatedAt: string;
}

export interface TemplateRow {
  id: string;
  subjectType: 'customer';
  subjectId: string;
  algoId: string;
  algoVersion: string;
  descriptorDim: number;
  bits: number;
  keyId: string;
  ciphertext: Uint8Array;
  qualityScore: number;
  captureSource: 'camera' | 'synthetic';
  status: 'active' | 'revoked';
  enrolledAt: string;
  revokedAt: string | null;
}

export interface TransactionRow {
  id: string;
  humanRef: string;
  type: TxnType;
  status: TxnStatus;
  amountPiasters: number;
  currency: string;
  customerAccountId: string | null;
  merchantAccountId: string | null;
  parentTransactionId: string | null;
  provider: string | null;
  providerRef: string | null;
  requestId: string | null;
  metaJson: string;
  failureCode: string | null;
  createdAt: string;
  settledAt: string | null;
}

export interface LedgerEntryRow {
  seq: number;
  entryId: string;
  transactionId: string;
  entryIndex: number;
  accountId: string;
  direction: 'debit' | 'credit';
  amountPiasters: number;
  balanceAfter: number;
  memo: string;
  createdAt: string;
}

export interface IdempotencyRow {
  scope: string;
  key: string;
  payloadHash: string;
  responseJson: string | null;
  httpStatus: number | null;
  createdAt: string;
}

export interface AuditRow {
  seq: number;
  ts: string;
  actorType: string;
  actorId: string;
  event: string;
  subjectType: string | null;
  subjectId: string | null;
  outcome: string;
  dataJson: string;
  prevHash: string;
  rowHash: string;
}
