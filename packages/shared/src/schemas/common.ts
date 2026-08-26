import { z } from 'zod';
import { MAX_DEPOSIT_PIASTERS, MAX_PAYMENT_PIASTERS, MIN_DEPOSIT_PIASTERS, MIN_PAYMENT_PIASTERS, PASSWORD_REGEX, PHONE_REGEX } from '../constants.js';

export const PhoneSchema = z.string().regex(PHONE_REGEX, 'Must be an Egyptian mobile number (+2010/11/12/15 + 8 digits)');
export const PasswordSchema = z.string().regex(PASSWORD_REGEX, 'Password must be at least 6 characters');

/** Integer piaster amounts; bounds enforced per-endpoint by the factories below. */
const PiastersSchema = z.number().int();

export const PaymentAmountSchema = PiastersSchema.min(MIN_PAYMENT_PIASTERS).max(MAX_PAYMENT_PIASTERS);
export const DepositAmountSchema = PiastersSchema.min(MIN_DEPOSIT_PIASTERS).max(MAX_DEPOSIT_PIASTERS);

/** ISO-8601 with timezone offset (client clock; server enforces the freshness window). */
export const TimestampSchema = z.iso.datetime({ offset: true });
export const RequestIdSchema = z.uuid();

export const CursorSchema = z.string().max(128).optional();
export const LimitSchema = z.coerce.number().int().min(1).max(100).default(20);

/** Capture source: real camera frames or the dev-only synthetic generator. */
export const CaptureSourceSchema = z.enum(['camera', 'synthetic']);
