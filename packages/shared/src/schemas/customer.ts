import { z } from 'zod';
import { DepositAmountSchema, PasswordSchema, PhoneSchema, RequestIdSchema, TimestampSchema } from './common.js';
import { EnrollPalmSchema, PalmProbeSchema } from './biometric.js';

export const RegisterCustomerSchema = z.object({
  name: z.string().min(2).max(80),
  phone: PhoneSchema,
  password: PasswordSchema
});
export type RegisterCustomerDTO = z.infer<typeof RegisterCustomerSchema>;

export const CustomerLoginSchema = z.object({
  phone: PhoneSchema,
  password: PasswordSchema
});

export const ChangePasswordSchema = z.object({
  currentPassword: PasswordSchema,
  newPassword: PasswordSchema
});

export const EnrollPalmRequestSchema = EnrollPalmSchema;
export type EnrollPalmRequest = z.infer<typeof EnrollPalmRequestSchema>;

export const PalmSelfTestSchema = z.object({ probe: PalmProbeSchema });
export type PalmSelfTestDTO = z.infer<typeof PalmSelfTestSchema>;

export const DeletePalmSchema = z.object({ password: PasswordSchema });

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
