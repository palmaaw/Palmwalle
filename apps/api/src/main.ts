/**
 * PalmPay API — PROTOTYPE entrypoint (the actual process).
 * ⚠️ Simulated wallet + simulated biometrics. No real financial transfers.
 */

import { buildApp, buildContext, loadConfig } from './index.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = await buildContext(config);
  const app = buildApp(ctx);

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info(`${signal} received — shutting down`);
    try {
      await app.close();
    } finally {
      ctx.db.close();
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  // eslint-disable-next-line no-console -- pre-logger failure path
  console.error('[palma] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
