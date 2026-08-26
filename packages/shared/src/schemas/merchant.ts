import { z } from 'zod';
import { PaymentAmountSchema, PasswordSchema, PhoneSchema, RequestIdSchema, TimestampSchema } from './common.js';
import { PalmProbeSchema } from './biometric.js';

export const RegisterMerchantSchema = z.object({
  name: z.string().min(2).max(80),
  code: z
    .string()
    .min(3)
    .max(24)
    .regex(/^[A-Z0-9-]+$/, 'Merchant code is uppercase letters, digits and dashes'),
  phone: PhoneSchema,
  password: PasswordSchema,
  displayName: z.string().min(1).max(60).optional()
});
export type RegisterMerchantDTO = z.infer<typeof RegisterMerchantSchema>;

export const MerchantLoginSchema = z.object({
  /** Either the merchant code or the registered phone. */
  identifier: z.string().min(3).max(40),
  password: PasswordSchema
});

/**
 * One-step scan & pay authorization.
 * requestId + timestamp are REQUIRED for replay protection; the server rejects
 * duplicates (payload-mismatch), true replays (idempotent original response) and
 * stale requests outside the freshness window.
 */
export const AuthorizePaymentSchema = z.object({
  requestId: RequestIdSchema,
  timestamp: TimestampSchema,
  amountPiasters: PaymentAmountSchema,
  probe: PalmProbeSchema
});
export type AuthorizePaymentDTO = z.infer<typeof AuthorizePaymentSchema>;

/** Outcome bodies for /payments/authorize (biometric rejections come back as 200 rejected). */
export const AuthorizeCompletedSchema = z.object({
  status: z.literal('completed'),
  transaction: z.unknown(), // TransactionDTO; kept loose here to avoid a circular import
  customer: z.object({ displayName: z.string(), maskedPhone: z.string() }),
  match: z.object({ outcome: z.enum(['match']), score: z.number(), threshold: z.number(), algoId: z.string() }),
  wallet: z.object({ accountId: z.string(), balancePiasters: z.number().int(), currency: z.string(), formatted: z.string() }),
  replayed: z.boolean().optional()
});
export const AuthorizeRejectedSchema = z.object({
  status: z.literal('rejected'),
  code: z.string(),
  message: z.string(),
  match: z
    .object({ outcome: z.enum(['no_match', 'ambiguous']), score: z.number(), threshold: z.number(), algoId: z.string() })
    .optional(),
  replayed: z.boolean().optional()
});

export const RefundSchema = z.object({
  requestId: RequestIdSchema,
  timestamp: TimestampSchema,
  reason: z.string().max(280).optional()
});
export type RefundDTO = z.infer<typeof RefundSchema>;
