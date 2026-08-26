/**
 * Smoke test: boot the REAL API in-process (ephemeral port, :memory: db) and
 * verify the critical path breathes — health, meta disclosure, one full
 * scan & pay cycle, integrity endpoints. Fast; the exhaustive checklist is
 * `npm run e2e`.
 *
 * ⚠️ SIMULATED biometrics + wallet throughout.
 */

import { bootServer, call, enrollBody, iso, probeBody, protectionKeyOf } from './lib.js';
import { randomUUID } from 'node:crypto';

let failures = 0;

function check(name: string, pass: boolean, note = ''): void {
  if (!pass) failures++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${note ? ` — ${note}` : ''}`);
}

async function main(): Promise<void> {
  console.log('Palm Wallet smoke (SIMULATED prototype)\n');
  const server = await bootServer(':memory:');
  try {
    const { base } = server;

    const health = await fetch(`${base}/healthz`);
    check('GET /healthz', health.status === 200);

    const meta = await call(base, 'GET', '/api/v1/meta');
    const bioMeta = (meta.data?.biometrics ?? {}) as { simulated?: boolean };
    check('meta discloses SIMULATED biometrics', meta.ok && bioMeta.simulated === true);

    const phone = '+2010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
    const reg = await call(base, 'POST', '/api/v1/customers/register', {
      body: { name: 'Smoke Tester', phone, password: 'smoke123' }
    });
    const token = (reg.data?.accessToken as string) ?? '';
    check('customer register → token', reg.ok && token.length > 20);

    const dep = await call(base, 'POST', '/api/v1/customers/me/deposits', {
      token,
      body: { requestId: randomUUID(), timestamp: iso(), amountPiasters: 150_000, source: 'instapay_sim' }
    });
    const wallet = (dep.data?.wallet ?? {}) as { balancePiasters?: number };
    check('simulated top-up settles', dep.ok && wallet.balancePiasters === 150_000);

    // Device-side protection: fetch the subkey like a real client, then build
    // the enrollment/probe codes locally before upload.
    const keyRes = await call(base, 'GET', '/api/v1/biometrics/protection-key', { token });
    const protectionKey = protectionKeyOf({
      biometrics: { protectionKeyB64: (keyRes.data?.protectionKeyB64 as string) ?? '' }
    });
    check('protection key delivered to authenticated client', keyRes.ok && protectionKey.length === 32);

    const enroll = await call(base, 'POST', '/api/v1/customers/me/palm/enroll', {
      token,
      body: enrollBody('aya', protectionKey)
    });
    check('palm enrollment accepted (code-only upload)', enroll.ok && enroll.data?.enrolled === true);

    const merch = await call(base, 'POST', '/api/v1/merchants/register', {
      setupToken: server.ctx.config.devSetupToken,
      body: { name: 'Smoke Shop', code: 'SMOKE-SHOP', phone: '+201200009999', password: 'smokeshop1' }
    });
    const merchToken = (merch.data?.accessToken as string) ?? '';
    check('merchant bootstrap → token', merch.ok && merchToken.length > 20);

    const pay = await call(base, 'POST', '/api/v1/payments/authorize', {
      token: merchToken,
      body: { requestId: randomUUID(), timestamp: iso(), amountPiasters: 4_500, probe: probeBody('aya', protectionKey) }
    });
    check(
      'scan & pay settles',
      pay.ok && pay.data?.status === 'completed' && (pay.data.wallet as { balancePiasters: number }).balancePiasters === 145_500
    );

    // Dev diagnostics are token-guarded; with the right token they must report OK.
    const denied = await call(base, 'GET', '/api/v1/dev/invariants');
    const inv = await call(base, 'GET', '/api/v1/dev/invariants', { devToken: server.ctx.config.devToken });
    check('invariants verified (and guard works)', denied.status === 403 && inv.data?.ok === true);
  } finally {
    await server.close();
  }

  console.log(`\nsmoke ${failures === 0 ? 'PASSED' : 'FAILED'} (${failures} failure${failures === 1 ? '' : 's'})`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('smoke crashed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
