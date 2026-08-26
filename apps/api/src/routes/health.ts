import { ALGO_ID, ALGO_VERSION, MATCH_GREY_FLOOR, MATCH_THRESHOLD, TEMPLATE_BITS } from '@palma/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../container.js';

export function healthRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/healthz', async () => ({ ok: true, data: { status: 'up' } }));

  app.get('/readyz', async () => {
    // Ready = migrations applied and the ledger sums.
    const totals = ctx.db
      .stmt(
        `SELECT
           COALESCE(SUM(CASE WHEN direction='debit' THEN amount_piasters END),0) AS d,
           COALESCE(SUM(CASE WHEN direction='credit' THEN amount_piasters END),0) AS c
         FROM ledger_entries`
      )
      .get() as { d: number; c: number };
    return {
      ok: true,
      data: {
        status: Number(totals.d) === Number(totals.c) ? 'ready' : 'degraded',
        ledgerBalanced: Number(totals.d) === Number(totals.c)
      }
    };
  });

  app.get('/api/v1/meta', async () => ({
    ok: true,
    data: {
      service: 'palmpay',
      prototype: true,
      currency: 'EGP',
      biometrics: {
        algoId: ALGO_ID,
        algoVersion: ALGO_VERSION,
        threshold: MATCH_THRESHOLD,
        greyFloor: MATCH_GREY_FLOOR,
        templateBits: TEMPLATE_BITS,
        simulated: true
      },
      limits: {
        minPaymentPiasters: ctx.config.minPaymentPiasters,
        maxPaymentPiasters: ctx.config.maxPaymentPiasters,
        minDepositPiasters: ctx.config.minDepositPiasters,
        maxDepositPiasters: ctx.config.maxDepositPiasters,
        freshnessWindowMs: ctx.config.freshnessWindowMs
      },
      demoMode: ctx.config.demoMode
    }
  }));
}
