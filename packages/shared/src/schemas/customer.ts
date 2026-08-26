import { z } from 'zod';
import { DepositAmountSchema, PhoneSchema, PinSchema, RequestIdSchema, TimestampSchema } from './common.js';
import { EnrollPalmSchema, PalmProbeSchema } from './biometric.js';

export const RegisterCustomerSchema = z.object({
  name: z.string().min(2).max(80),
  phone: PhoneSchema,
  pin: PinSchema
});
export type RegisterCustomerDTO = z.infer<typeof RegisterCustomerSchema>;

export const CustomerLoginSchema = z.object({
  phone: PhoneSchema,
  pin: PinSchema
});

export const ChangePinSchema = z.object({
  currentPin: PinSchema,
  newPin: PinSchema
});

export const EnrollPalmRequestSchema = EnrollPalmSchema;
export type EnrollPalmRequest = z.infer<typeof EnrollPalmRequestSchema>;

export const PalmSelfTestSchema = z.object({ probe: PalmProbeSchema });
export type PalmSelfTestDTO = z.infer<typeof PalmSelfTestSchema>;

export const DeletePalmSchema = z.object({ pin: PinSchema });

/** SIMULATED top-up sources — placeholders for licensed Egyptian providers. */
export const DepositSourceSchema = z.enum(['instapay_sim', 'vodafone_cash_sim']);
export type DepositSource = z.infer<typeof DepositSourceSchema>;

export const CreateDepositSchema = z.object({
  requestId: RequestIdSchema,
  timestamp: TimestampSchema,
  amountPiasters: DepositAmountSchema,
  source: DepositSourceSchema
});
export type CreateDepositDTO = z.infer<typeof CreateDepositSchema>;
