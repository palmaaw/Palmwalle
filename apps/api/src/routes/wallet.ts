/**
 * Customer wallet: balance, SIMULATED provider top-ups, transaction history.
 */

import { ApiError, isFresh } from '@palmwallet/shared';
import { CreateDepositSchema, LimitSchema } from '@palmwallet/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../container.js';
import { transactionDTO, walletDTO } from '../dto.js';
import { parseBody, parseQuery } from '../lib.js';
import { mapHistory } from './history.js';

const HistoryQuerySchema = z.object({ cursor: z.string().max(256).optional(), limit: LimitSchema.optional() });

export function walletRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/customers/me/wallet', { onRequest: [ctx.auth.requireCustomer] }, async (req) => {
    const me = req.customer!;
    const account = ctx.repos.accounts.ensureForOwner({ ownerType: 'customer', ownerId: me.id });
    return { ok: true as const, data: { wallet: walletDTO(account) } };
  });

  /** Simulated top-up through a placeholder provider adapter. */
  app.post('/api/v1/customers/me/deposits', { onRequest: [ctx.auth.requireCustomer] }, async (req, reply) => {
    const body = parseBody(req, CreateDepositSchema);
    const me = req.customer!;

    if (!isFresh(body.timestamp, Date.now(), ctx.config.freshnessWindowMs)) {
      throw new ApiError('REQUEST_STALE', 'Request timestamp is outside the allowed freshness window');
    }

    // Hash SEMANTIC content only (like payments/refunds): a byte-identical
    // retry OR a regenerated-timestamp retry with the same requestId + amount +
    // source replays the original outcome; anything else conflicts.
    const result = await ctx.idem.run(
      'deposits.create',
      body.requestId,
      { requestId: body.requestId, amountPiasters: body.amountPiasters, source: body.source },
      async () => {
      // Provider call happens BEFORE any money moves; the SIMULATED adapter is
      // deterministic (fails on the nil-uuid sentinel — see providers/registry.ts).
      const provider = ctx.providers.get(body.source);
      const topUp = await provider.initiateTopUp({
        requestId: body.requestId,
        amountPiasters: body.amountPiasters,
        currency: 'EGP',
        customerRef: me.id
      });
      if (!topUp.ok) {
        // Record the failed attempt for auditability — no ledger movement.
        ctx.ledger.recordFailedDeposit({
          customer: me,
          amountPiasters: body.amountPiasters,
          source: body.source,
          requestId: body.requestId,
          failureCode: 'PROVIDER_FAILED'
        });
        throw new ApiError('PROVIDER_FAILED', `${body.source} could not complete the top-up`);
      }
      const account = ctx.repos.accounts.ensureForOwner({ ownerType: 'customer', ownerId: me.id });
      const txn = ctx.ledger.deposit({
        customer: me,
        customerAccount: account,
        amountPiasters: body.amountPiasters,
        source: body.source,
        requestId: body.requestId,
        providerRef: topUp.providerRef
      });
      const after = ctx.repos.accounts.getById(account.id)!;
      return {
        data: {
          status: 'completed' as const,
          transaction: transactionDTO(txn, { viewerAccountId: account.id, counterpartyFor: () => null, parentRefFor: () => null }),
          wallet: walletDTO(after)
        },
        httpStatus: 201
      };
      }
    );

    // Replays reuse the ORIGINAL stored status verbatim.
    return reply.status(result.httpStatus).send({
      ok: true as const,
      data: { ...result.data, replayed: result.replayed || undefined }
    });
  });

  app.get('/api/v1/customers/me/transactions', { onRequest: [ctx.auth.requireCustomer] }, async (req) => {
    const me = req.customer!;
    const q = parseQuery(req, HistoryQuerySchema);
    const account = ctx.repos.accounts.ensureForOwner({ ownerType: 'customer', ownerId: me.id });
    const page = ctx.repos.txns.listByAccount(account.id, { limit: q.limit ?? 20, cursor: q.cursor ?? null });
    return {
      ok: true as const,
      data: { items: mapHistory(ctx, page.items, account.id), nextCursor: page.nextCursor }
    };
  });
}
