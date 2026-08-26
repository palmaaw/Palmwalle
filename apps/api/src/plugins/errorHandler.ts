/**
 * Error envelope mapping: every failure leaves as
 * {ok:false, error:{code,message,details?}} with the shared ErrorCode->HTTP map.
 * Zod validation issues become VALIDATION_ERROR(400); unknown errors are logged
 * server-side and returned as INTERNAL without internals leaking.
 */

import type { FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { ApiError, httpStatusFor } from '@palma/shared';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(httpStatusFor(err.code)).send({
        ok: false,
        error: { code: err.code, message: err.message, details: err.details ?? undefined }
      });
    }

    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.status(400).send({
        ok: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'Invalid request',
          details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
        }
      });
    }

    // fastify-json body parse errors and friends carry a statusCode
    const fe = err as { statusCode?: number; message?: string };
    const status = typeof fe.statusCode === 'number' ? fe.statusCode : 500;
    if (status < 500) {
      return reply.status(status).send({
        ok: false,
        error: { code: status === 404 ? 'NOT_FOUND' : 'VALIDATION_ERROR', message: fe.message ?? 'Bad request' }
      });
    }

    req.log.error({ err: err instanceof Error ? err.message : String(err) }, 'unhandled error');
    return reply.status(500).send({
      ok: false,
      error: { code: 'INTERNAL', message: 'Something went wrong on our side' }
    });
  });

  app.setNotFoundHandler((_req, reply) => {
    return reply.status(404).send({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'Unknown route' }
    });
  });
}
