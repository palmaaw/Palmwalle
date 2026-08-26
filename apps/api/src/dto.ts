/**
 * Row -> wire DTO mappers. These are the ONLY place persistence shapes touch
 * response bodies; fields not selected here (pin_hash, ciphertext, meta_json
 * internals...) structurally cannot leak.
 */

import { CURRENCY, formatEGP } from '@palma/shared';
import type {
  CustomerDTO,
  MerchantDTO,
  TransactionDTO,
  WalletDTO,
  MaskedParty,
  MatchInfo
} from '@palma/shared';
import type { CustomerRow, LedgerEntryRow, MerchantRow, TransactionRow, WalletAccountRow } from '@palma/db';
import type { BestMatchResult } from '@palma/biometrics';

/** Mask Egyptian mobiles like +201012345678 -> +2010•••5678. */
export function maskPhone(phone: string): string {
  if (phone.length < 9) return '•••';
  return `${phone.slice(0, 6)}•••${phone.slice(-3)}`;
}

export function customerDTO(row: CustomerRow, palmEnrolled: boolean): CustomerDTO {
  return {
    id: row.id,
    name: row.name,
    maskedPhone: maskPhone(row.phone),
    palmEnrolled,
    status: row.status
  };
}

export function merchantDTO(row: MerchantRow): MerchantDTO {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    maskedPhone: maskPhone(row.phone),
    status: row.status
  };
}

export function walletDTO(account: WalletAccountRow): WalletDTO {
  return {
    accountId: account.id,
    balancePiasters: account.balancePiasters,
    currency: CURRENCY,
    formatted: formatEGP(account.balancePiasters)
  };
}

export interface TxnViewContext {
  /** The wallet whose owner is reading the history — sets the sign convention. */
  viewerAccountId: string;
  /** Display info of counterparties, resolved by the caller (route layer). */
  counterpartyFor(row: TransactionRow): MaskedParty | null;
  parentRefFor(row: TransactionRow): string | null;
}

export function transactionDTO(row: TransactionRow, ctx: TxnViewContext): TransactionDTO {
  // Money IN to the viewer's wallet is positive; OUT is negative.
  let signed = row.amountPiasters;
  if (ctx.viewerAccountId === row.customerAccountId) {
    signed = row.type === 'deposit' || row.type === 'refund' ? row.amountPiasters : -row.amountPiasters;
  } else if (ctx.viewerAccountId === row.merchantAccountId) {
    signed = row.type === 'payment' ? row.amountPiasters : -row.amountPiasters;
  } else if (row.type === 'deposit') {
    signed = row.amountPiasters; // system-side view
  }
  return {
    id: row.id,
    ref: row.humanRef,
    type: row.type,
    status: row.status,
    signedAmountPiasters: signed,
    formatted: formatEGP(signed),
    counterparty: ctx.counterpartyFor(row),
    parentRef: ctx.parentRefFor(row),
    provider: row.provider,
    failureCode: row.failureCode,
    createdAt: row.createdAt,
    settledAt: row.settledAt
  };
}

/** Match info for the wire: outcome/score/threshold ONLY — never features. */
export function matchInfo(m: BestMatchResult): MatchInfo {
  return {
    outcome: m.decision === 'match' ? 'match' : m.decision,
    score: Math.round(m.similarity * 10000) / 10000,
    threshold: m.threshold,
    algoId: 'palma-sim-hog-v1'
  };
}

export interface LedgerLineDTO {
  seq: number;
  direction: string;
  amountPiasters: number;
  balanceAfter: number;
  memo: string;
  createdAt: string;
}

export function ledgerLines(entries: LedgerEntryRow[]): LedgerLineDTO[] {
  return entries.map((e) => ({
    seq: e.seq,
    direction: e.direction,
    amountPiasters: e.amountPiasters,
    balanceAfter: e.balanceAfter,
    memo: e.memo,
    createdAt: e.createdAt
  }));
}
