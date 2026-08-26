/**
 * buildApp(): Fastify instance wired to an AppContext. Exported separately from
 * the listener so integration tests can drive it with fastify.inject().
 */

import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { PalmWalletDatabase } from '@palmwallet/db';

import type { AppContext } from './container.js';
import { asFastifyLogger } from './logging.js';
import { createLogger } from './logging.js';
import { registerErrorHandler } from './plugins/errorHandler.js';
import { customerAuthRoutes } from './routes/customerAuth.js';
import { devRoutes } from './routes/dev.js';
import { healthRoutes } from './routes/health.js';
import { merchantAuthRoutes } from './routes/merchantAuth.js';
import { palmRoutes } from './routes/palm.js';
import { paymentRoutes } from './routes/payments.js';
import { walletRoutes } from './routes/wallet.js';

declare module 'fastify' {
  interface FastifyInstance {
    palmWalletDb: PalmWalletDatabase;
  }
}

export function buildApp(ctx: AppContext) {
  const log = createLogger(ctx.config.logLevel);
  const app = Fastify({
    loggerInstance: asFastifyLogger(log),
    disableRequestLogging: ctx.config.logLevel !== 'debug',
    bodyLimit: 1024 * 256 // descriptors are ~1.4KB; generous but bounded
  });

  app.decorate('palmWalletDb', ctx.db);

  void app.register(cors, {
    origin: ctx.config.corsOrigins === '*' ? true : ctx.config.corsOrigins,
    credentials: false
  });

  registerErrorHandler(app);
  app.log.info(`Palm Wallet API starting — PROTOTYPE${ctx.config.demoMode ? ' (DEMO MODE)' : ''}`);

  healthRoutes(app, ctx);
  customerAuthRoutes(app, ctx);
  palmRoutes(app, ctx);
  walletRoutes(app, ctx);
  merchantAuthRoutes(app, ctx);
  paymentRoutes(app, ctx);
  devRoutes(app, ctx);

  // Request timing at info level (redaction happens in the logger).
  app.addHook('onResponse', async (req, reply) => {
    if (req.url === '/healthz') return;
    req.log.info(
      {
        method: req.method,
        url: req.url,
        status: reply.statusCode,
        durationMs: Math.round((reply.elapsedTime ?? 0) * 1000) / 1000
      },
      'request'
    );
  });

  return app;
}
