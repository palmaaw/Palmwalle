import { z } from 'zod';
import { CURRENCY } from '../constants.js';

/**
 * Response DTOs. These are also validated by API integration tests so a handler
 * drifting from the shared contract fails tests rather than the demo.
 */

export const MaskedPartySchema = z.object({
  displayName: z.string(),
  maskedPhone: z.string()
});
export type MaskedParty = z.infer<typeof MaskedPartySchema>;

export const MatchInfoSchema = z.object({
  outcome: z.enum(['match', 'no_match', 'ambiguous']),
  score: z.number(), // similarity in [0,1], rounded to 4dp on the wire
  threshold: z.number(),
  algoId: z.string()
});
export type MatchInfo = z.infer<typeof MatchInfoSchema>;

export const WalletDTOSchema = z.object({
  accountId: z.string(),
  balancePiasters: z.number().int(),
  currency: z.literal(CURRENCY),
  formatted: z.string()
});
export type WalletDTO = z.infer<typeof WalletDTOSchema>;

export const CustomerDTOSchema = z.object({
  id: z.string(),
  name: z.string(),
  maskedPhone: z.string(),
  palmEnrolled: z.boolean(),
  status: z.string()
});
export type CustomerDTO = z.infer<typeof CustomerDTOSchema>;

export const MerchantDTOSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  maskedPhone: z.string(),
  status: z.string()
});
export type MerchantDTO = z.infer<typeof MerchantDTOSchema>;

export const TransactionDTOSchema = z.object({
  id: z.string(),
  ref: z.string(),
  type: z.enum(['deposit', 'payment', 'refund']),
  status: z.enum(['pending', 'completed', 'failed', 'reversed']),
  /** Signed amount relative to the viewer: money in is positive, money out is negative. */
  signedAmountPiasters: z.number().int(),
  formatted: z.string(),
  counterparty: MaskedPartySchema.nullable(),
  parentRef: z.string().nullable(),
  provider: z.string().nullable(),
  failureCode: z.string().nullable(),
  createdAt: z.string(),
  settledAt: z.string().nullable()
});
export type TransactionDTO = z.infer<typeof TransactionDTOSchema>;

export function makePage<T>(items: T[], nextCursor: string | null): Page<T> {
  return { items, nextCursor };
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
