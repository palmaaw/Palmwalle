/**
 * Merchant bootstrap (guarded by X-Setup-Token) + login + profile/wallet.
 */

import { ApiError } from '@palmwallet/shared';
import { LimitSchema, MerchantLoginSchema, RegisterMerchantSchema } from '@palmwallet/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../container.js';
import { merchantDTO, walletDTO } from '../dto.js';
import { isUniqueViolation, parseBody, parseQuery } from '../lib.js';
import { hashPassword, verifyPassword } from '../security/passwordHash.js';
import { mapHistory } from './history.js';

const HistoryQuerySchema = z.object({ cursor: z.string().max(256).optional(), limit: LimitSchema.optional() });

export function merchantAuthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/api/v1/merchants/register', async (req) => {
    const setupToken = req.headers['x-setup-token'];
    if (!setupToken || setupToken !== ctx.config.devSetupToken) {
      throw new ApiError('FORBIDDEN', 'Valid X-Setup-Token required to register a merchant');
    }
    const body = parseBody(req, RegisterMerchantSchema);
    if (ctx.repos.merchants.getByCode(body.code)) throw new ApiError('ACCOUNT_EXISTS', 'Merchant code already registered');
    const id = crypto.randomUUID();
    try {
      ctx.repos.merchants.insert({
        id,
        code: body.code,
        name: body.displayName ?? body.name,
        phone: body.phone,
        passwordHash: hashPassword(body.password)
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new ApiError('ACCOUNT_EXISTS', 'Merchant code or phone already registered');
      throw err;
    }
    ctx.repos.accounts.ensureForOwner({ ownerType: 'merchant', ownerId: id });
    ctx.repos.audit.append({
      actorType: 'system',
      actorId: 'setup',
      event: 'merchant.registered',
      subjectType: 'merchant',
      subjectId: id,
      data: { code: body.code }
    });
    const row = ctx.repos.merchants.getById(id)!;
    const token = await ctx.tokens.sign({ sub: id, typ: 'merchant', name: row.name });
    return {
      ok: true as const,
      data: { accessToken: token, tokenType: 'Bearer' as const, expiresInSeconds: ctx.config.jwtTtlSeconds, merchant: merchantDTO(row) }
    };
  });

  app.post('/api/v1/auth/merchant/login', async (req) => {
    const body = parseBody(req, MerchantLoginSchema);
    const throttleKey = `merch:${body.identifier}:${req.ip}`;
    if (!ctx.throttle.allow(throttleKey)) {
      throw new ApiError('RATE_LIMITED', `Too many attempts — retry in ${ctx.throttle.retryAfterSeconds(throttleKey)}s`);
    }
    const row = /^[A-Z0-9-]{3,24}$/.test(body.identifier)
      ? ctx.repos.merchants.getByCode(body.identifier)
      : ctx.repos.merchants.getByPhone(body.identifier);
    const okPassword = row ? verifyPassword(body.password, row.passwordHash) : false;
    if (!row || !okPassword) {
      ctx.throttle.recordFailure(throttleKey);
      ctx.repos.audit.append({ actorType: 'merchant', actorId: body.identifier, event: 'auth.login', outcome: 'rejected' });
      throw new ApiError('AUTH_INVALID_CREDENTIALS', 'Wrong credentials');
    }
    if (row.status !== 'active') throw new ApiError('ACCOUNT_DISABLED', 'This merchant account is disabled');
    ctx.throttle.clear(throttleKey);
    const token = await ctx.tokens.sign({ sub: row.id, typ: 'merchant', name: row.name });
    return {
      ok: true as const,
      data: { accessToken: token, tokenType: 'Bearer' as const, expiresInSeconds: ctx.config.jwtTtlSeconds, merchant: merchantDTO(row) }
    };
  });

  app.get('/api/v1/merchants/me', { onRequest: [ctx.auth.requireMerchant] }, async (req) => {
    return { ok: true as const, data: { merchant: merchantDTO(req.merchant!) } };
  });

  app.get('/api/v1/merchants/me/wallet', { onRequest: [ctx.auth.requireMerchant] }, async (req) => {
    const me = req.merchant!;
    const account = ctx.repos.accounts.ensureForOwner({ ownerType: 'merchant', ownerId: me.id });
    return { ok: true as const, data: { wallet: walletDTO(account) } };
  });

  app.get('/api/v1/merchants/me/transactions', { onRequest: [ctx.auth.requireMerchant] }, async (req) => {
    const me = req.merchant!;
    const q = parseQuery(req, HistoryQuerySchema);
    const account = ctx.repos.accounts.ensureForOwner({ ownerType: 'merchant', ownerId: me.id });
    const page = ctx.repos.txns.listByAccount(account.id, { limit: q.limit ?? 20, cursor: q.cursor ?? null });
    return {
      ok: true as const,
      data: { items: mapHistory(ctx, page.items, account.id), nextCursor: page.nextCursor }
    };
  });
}
