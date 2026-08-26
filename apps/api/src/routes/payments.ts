/**
 * Merchant-side payment endpoints: one-step authorize + refunds.
 */

import { ApiError, isFresh } from '@palmwallet/shared';
import { AuthorizePaymentSchema, RefundSchema } from '@palmwallet/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../container.js';
import { transactionDTO, walletDTO } from '../dto.js';
import { parseBody } from '../lib.js';

export function paymentRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** ONE-STEP scan & pay: identify the palm and settle atomically. */
  app.post('/api/v1/payments/authorize', { onRequest: [ctx.auth.requireMerchant] }, async (req, reply) => {
    const body = parseBody(req, AuthorizePaymentSchema);
    const outcome = await ctx.payments.authorize(req.merchant!, body);
    return reply.status(outcome.httpStatus).send({ ok: true as const, data: outcome.body });
  });

  /** Full-and-once refund of a payment this merchant owns. */
  app.post('/api/v1/transactions/:ref/refund', { onRequest: [ctx.auth.requireMerchant] }, async (req) => {
    const { ref } = req.params as { ref: string };
    const body = parseBody(req, RefundSchema);
    const me = req.merchant!;

    if (!isFresh(body.timestamp, Date.now(), ctx.config.freshnessWindowMs)) {
      throw new ApiError('REQUEST_STALE', 'Request timestamp is outside the allowed freshness window');
    }

    const result = await ctx.idem.run(
      'payments.refund',
      body.requestId,
      { requestId: body.requestId, ref, reason: body.reason ?? null },
      async () => {
        const parent = ctx.repos.txns.getByRef(ref);
        if (!parent) throw new ApiError('NOT_FOUND', 'No such transaction');
        const txn = ctx.ledger.refund({
          parent,
          merchant: me,
          reason: body.reason,
          requestId: body.requestId
        });
        const merchantAccount = ctx.repos.accounts.ensureForOwner({ ownerType: 'merchant', ownerId: me.id });
        const customerAccount = parent.customerAccountId ? ctx.repos.accounts.getById(parent.customerAccountId) : null;
        return {
          data: {
            status: 'refunded' as const,
            refund: transactionDTO(txn, {
              viewerAccountId: merchantAccount.id,
              counterpartyFor: () => null,
              parentRefFor: () => parent.humanRef
            }),
            customerWalletAfter: customerAccount ? walletDTO(ctx.repos.accounts.getById(customerAccount.id)!) : null
          },
          httpStatus: 200
        };
      }
    );

    return { ok: true as const, data: { ...result.data, replayed: result.replayed || undefined } };
  });
}
