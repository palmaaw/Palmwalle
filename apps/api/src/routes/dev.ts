/**
 * Dev/diagnostics endpoints — guarded by X-Dev-Token. Prototype tooling only;
 * a production system would replace these with proper ops dashboards.
 */

import { ApiError } from '@palma/shared';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../container.js';

function requireDevToken(ctx: AppContext) {
  return async (req: unknown): Promise<void> => {
    const header = (req as { headers: Record<string, string | string[] | undefined> }).headers['x-dev-token'];
    if (!header || header !== ctx.config.devToken) throw new ApiError('FORBIDDEN', 'Valid X-Dev-Token required');
  };
}

export function devRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/v1/dev/invariants', { onRequest: [requireDevToken(ctx)] }, async () => {
    const { collectInvariants } = await import('@palma/db');
    const report = collectInvariants(ctx.db);
    return { ok: true as const, data: report };
  });

  app.get('/api/v1/dev/audit/verify', { onRequest: [requireDevToken(ctx)] }, async () => {
    const verification = ctx.repos.audit.verifyChain();
    return { ok: true as const, data: verification };
  });

  app.get('/api/v1/dev/audit/tail', { onRequest: [requireDevToken(ctx)] }, async (req) => {
    const q = Number((req.query as { limit?: string })?.limit ?? 20);
    const limit = Number.isFinite(q) ? Math.min(Math.max(q, 1), 200) : 20;
    // Audit rows already exclude secrets by construction; show as stored.
    const rows = ctx.repos.audit.list(limit);
    return {
      ok: true as const,
      data: {
        items: rows.map((r) => ({
          seq: r.seq,
          ts: r.ts,
          actorType: r.actorType,
          event: r.event,
          outcome: r.outcome,
          subjectId: r.subjectId,
          dataJson: r.dataJson
        }))
      }
    };
  });
}
