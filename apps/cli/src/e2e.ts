/**
 * Headless END-TO-END run of the whole prototype over REAL HTTP (ephemeral
 * port, temp-file SQLite). No browser, no mocks: the same wire the PWAs use.
 *
 * Checklist: register → enroll → top-up (+ replay/mutate/stale/provider-fail
 * matrix) → merchant bootstrap → correct-palm pay → unknown-palm reject →
 * authorize replay/mutate → insufficient funds → refund (+ repeat refused) →
 * both histories → invariants + audit chain → privacy grep over every body.
 *
 * ⚠️ SIMULATED biometrics + simulated wallet rails. Exits nonzero on any FAIL.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { bootServer, call, enrollBody, failingRequestId, iso, probeBody, protectionKeyOf } from './lib.js';
import type { ApiResponse } from './lib.js';

interface StepResult {
  name: string;
  pass: boolean;
  note: string;
}

const results: StepResult[] = [];
/** Every response body seen during the run — grepped for leaks at the end. */
const bodies: string[] = [];

function note(resp: ApiResponse): ApiResponse {
  bodies.push(JSON.stringify(resp.raw));
  return resp;
}

async function step(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    results.push({ name, pass: true, note: detail });
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, pass: false, note: msg });
    console.log(`  FAIL  ${name} — ${msg}`);
  }
}

function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function errCode(r: ApiResponse): string {
  return r.error?.code ?? '(no code)';
}

async function main(): Promise<void> {
  console.log('PalmPay headless E2E — ⚠️ SIMULATED prototype\n');
  const dir = mkdtempSync(join(tmpdir(), 'palma-e2e-'));
  const server = await bootServer(join(dir, 'e2e.db'));
  const { base, ctx } = server;

  // Shared state across steps.
  let custToken = '';
  let custPhone = '';
  let merchToken = '';
  let payRef = '';
  let balance = -1;

  const walletOf = async (): Promise<number> => {
    const r = note(await call(base, 'GET', '/api/v1/customers/me/wallet', { token: custToken }));
    return ((r.data?.wallet ?? {}) as { balancePiasters: number }).balancePiasters;
  };
  const merchWalletOf = async (): Promise<number> => {
    const r = note(await call(base, 'GET', '/api/v1/merchants/me/wallet', { token: merchToken }));
    return ((r.data?.wallet ?? {}) as { balancePiasters: number }).balancePiasters;
  };

  try {
    await step('health endpoint up', async () => {
      const res = await fetch(`${base}/healthz`);
      expect(res.status === 200, `status ${res.status}`);
      return 'ok:true';
    });

    await step('meta discloses SIMULATED biometrics + limits', async () => {
      const r = note(await call(base, 'GET', '/api/v1/meta'));
      const bio = (r.data?.biometrics ?? {}) as { simulated?: boolean; threshold?: number };
      expect(r.data?.prototype === true, 'prototype flag missing');
      expect(bio.simulated === true, 'simulated flag missing');
      expect(typeof bio.threshold === 'number', 'threshold missing');
      return `threshold=${bio.threshold}`;
    });

    // The device-visible protection subkey (fetched authenticated, exactly as
    // the PWAs do). Its response is intentionally NOT added to the privacy-grep
    // corpus via note(): delivering this key to an authenticated client is BY
    // DESIGN in this prototype (production readers hold keys in secure
    // hardware) — everything else must stay clean.
    let protectionKey!: Uint8Array;

    await step('register customer', async () => {
      custPhone = '+2010' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
      const r = note(
        await call(base, 'POST', '/api/v1/customers/register', { body: { name: 'E2E Aya', phone: custPhone, pin: '1234' } })
      );
      expect(r.ok && typeof r.data?.accessToken === 'string', `status ${r.status} ${errCode(r)}`);
      custToken = r.data!.accessToken as string;
      const k = await call(base, 'GET', '/api/v1/biometrics/protection-key', { token: custToken });
      expect(k.ok && typeof k.data?.protectionKeyB64 === 'string', `protection-key ${k.status} ${errCode(k)}`);
      protectionKey = protectionKeyOf({ biometrics: { protectionKeyB64: k.data!.protectionKeyB64 as string } });
      expect(protectionKey.length === 32, 'protection key must be 32 bytes');
      return custPhone;
    });

    await step('unauthenticated protection-key fetch → rejected', async () => {
      const r = await call(base, 'GET', '/api/v1/biometrics/protection-key');
      expect(r.status === 401 && errCode(r) === 'AUTH_REQUIRED', `${r.status} ${errCode(r)}`);
      return errCode(r);
    });

    await step('enroll palm (frames protected ON DEVICE, code-only upload)', async () => {
      const r = note(
        await call(base, 'POST', '/api/v1/customers/me/palm/enroll', {
          token: custToken,
          body: enrollBody('aya', protectionKey)
        })
      );
      expect(r.ok && r.data?.enrolled === true, `${r.status} ${errCode(r)}`);
      return `template ${(r.data!.templateId as string).slice(0, 8)}…`;
    });

    await step('simulated InstaPay-style top-up EGP 2,500', async () => {
      const r = note(
        await call(base, 'POST', '/api/v1/customers/me/deposits', {
          token: custToken,
          body: { requestId: randomUUID(), timestamp: iso(), amountPiasters: 250_000, source: 'instapay_sim' }
        })
      );
      expect(r.ok && r.data?.status === 'completed', `${r.status} ${errCode(r)}`);
      balance = ((r.data!.wallet as { balancePiasters: number }).balancePiasters);
      expect(balance === 250_000, `balance ${balance}`);
      return 'wallet EGP 2,500.00';
    });

    const depReplayId = randomUUID();
    await step('deposit REPLAY → original response, no double credit', async () => {
      const body = { requestId: depReplayId, timestamp: iso(), amountPiasters: 10_000, source: 'instapay_sim' };
      const first = note(await call(base, 'POST', '/api/v1/customers/me/deposits', { token: custToken, body }));
      const again = note(await call(base, 'POST', '/api/v1/customers/me/deposits', { token: custToken, body: { ...body, timestamp: iso() } }));
      expect(first.ok && again.ok, `${errCode(first)}/${errCode(again)}`);
      expect(again.data?.replayed === true, 'replayed flag missing');
      const b = await walletOf();
      expect(b === balance + 10_000, `balance moved to ${b}`);
      balance = b;
      return 'replayed:true';
    });

    await step('deposit MUTATED payload on same requestId → 409', async () => {
      const r = note(
        await call(base, 'POST', '/api/v1/customers/me/deposits', {
          token: custToken,
          body: { requestId: depReplayId, timestamp: iso(), amountPiasters: 99_000, source: 'instapay_sim' }
        })
      );
      expect(r.status === 409 && errCode(r) === 'REQUEST_REPLAY_PAYLOAD_MISMATCH', `${r.status} ${errCode(r)}`);
      return errCode(r);
    });

    await step('STALE deposit timestamp (-10 min) → rejected', async () => {
      const r = note(
        await call(base, 'POST', '/api/v1/customers/me/deposits', {
          token: custToken,
          body: { requestId: randomUUID(), timestamp: iso(-10 * 60_000), amountPiasters: 5_000, source: 'instapay_sim' }
        })
      );
      expect(errCode(r) === 'REQUEST_STALE', `${r.status} ${errCode(r)}`);
      return errCode(r);
    });

    await step('SIMULATED provider outage → 502, zero movement', async () => {
      const before = await walletOf();
      const r = note(
        await call(base, 'POST', '/api/v1/customers/me/deposits', {
          token: custToken,
          body: { requestId: failingRequestId(), timestamp: iso(), amountPiasters: 7_500, source: 'vodafone_cash_sim' }
        })
      );
      expect(r.status === 502 && errCode(r) === 'PROVIDER_FAILED', `${r.status} ${errCode(r)}`);
      expect((await walletOf()) === before, 'money moved despite provider failure');
      return 'no ledger movement';
    });

    await step('merchant bootstrap guarded by setup token', async () => {
      const bad = note(
        await call(base, 'POST', '/api/v1/merchants/register', {
          body: { name: 'No Token Shop', code: 'NO-TOKEN-SHOP', phone: '+201200007777', pin: '2468' }
        })
      );
      expect(bad.status === 403, `expected 403 got ${bad.status}`);
      const ok = note(
        await call(base, 'POST', '/api/v1/merchants/register', {
          setupToken: ctx.config.devSetupToken,
          body: { name: 'Zamalek Coffee (e2e)', code: 'E2E-CAFE', phone: '+201200006666', pin: '2468' }
        })
      );
      expect(ok.ok && typeof ok.data?.accessToken === 'string', `${ok.status} ${errCode(ok)}`);
      merchToken = ok.data!.accessToken as string;
      return 'E2E-CAFE';
    });

    await step('ONE-STEP scan & pay with the RIGHT palm settles atomically', async () => {
      const mBefore = await merchWalletOf();
      const r = note(
        await call(base, 'POST', '/api/v1/payments/authorize', {
          token: merchToken,
          body: { requestId: randomUUID(), timestamp: iso(), amountPiasters: 12_000, probe: probeBody('aya', protectionKey) }
        })
      );
      expect(r.ok && r.data?.status === 'completed', `${r.status} ${errCode(r)}`);
      const match = (r.data!.match ?? {}) as { outcome?: string; similarityBand?: string };
      expect(match.outcome === 'match', `outcome ${match.outcome}`);
      expect(match.similarityBand === 'high', `band ${match.similarityBand}`);
      payRef = (r.data!.transaction as { ref: string }).ref;
      const expected = balance - 12_000; // balance includes the replay top-up
      balance = (r.data!.wallet as { balancePiasters: number }).balancePiasters;
      expect(balance === expected, `customer balance ${balance} ≠ ${expected}`);
      expect((await merchWalletOf()) - mBefore === 12_000, 'merchant credit mismatch');
      return `${payRef} band=${match.similarityBand}`;
    });

    await step('UNKNOWN palm → 200 rejected, ZERO movement', async () => {
      const mBefore = await merchWalletOf();
      const r = note(
        await call(base, 'POST', '/api/v1/payments/authorize', {
          token: merchToken,
          body: { requestId: randomUUID(), timestamp: iso(), amountPiasters: 3_300, probe: probeBody('not-a-customer', protectionKey) }
        })
      );
      expect(r.status === 200 && r.data?.status === 'rejected', `${r.status}`);
      expect(r.data?.code === 'BIOMETRIC_NO_MATCH', `code ${r.data?.code}`);
      expect((await merchWalletOf()) === mBefore, 'money moved on rejected palm');
      return 'BIOMETRIC_NO_MATCH';
    });

    const authzId = randomUUID();
    await step('authorize REPLAY → same transaction, no double charge', async () => {
      const authzBody = { requestId: authzId, timestamp: iso(), amountPiasters: 5_000, probe: probeBody('aya', protectionKey) };
      const first = note(await call(base, 'POST', '/api/v1/payments/authorize', { token: merchToken, body: authzBody }));
      const again = note(await call(base, 'POST', '/api/v1/payments/authorize', { token: merchToken, body: { ...authzBody, timestamp: iso() } }));
      expect(first.ok && again.ok, `${errCode(first)}/${errCode(again)}`);
      expect(again.data?.replayed === true, 'replayed flag missing');
      expect(
        (first.data!.transaction as { ref: string }).ref === (again.data!.transaction as { ref: string }).ref,
        'different refs'
      );
      expect((await walletOf()) === balance - 5_000, 'double settlement detected');
      balance -= 5_000;
      return (first.data!.transaction as { ref: string }).ref;
    });

    await step('authorize MUTATED payload on same requestId → 409', async () => {
      const r = note(
        await call(base, 'POST', '/api/v1/payments/authorize', {
          token: merchToken,
          body: { requestId: authzId, timestamp: iso(), amountPiasters: 50_000, probe: probeBody('aya', protectionKey) }
        })
      );
      expect(r.status === 409 && errCode(r) === 'REQUEST_REPLAY_PAYLOAD_MISMATCH', `${r.status} ${errCode(r)}`);
      return errCode(r);
    });

    await step('zero-balance customer → INSUFFICIENT_FUNDS', async () => {
      const reg = note(
        await call(base, 'POST', '/api/v1/customers/register', { body: { name: 'Broke Nour', phone: '+201099999001', pin: '1234' } })
      );
      const brokeToken = reg.data?.accessToken as string;
      const k = await call(base, 'GET', '/api/v1/biometrics/protection-key', { token: brokeToken });
      protectionKey = protectionKeyOf({ biometrics: { protectionKeyB64: (k.data!.protectionKeyB64 as string) } });
      const enr = note(
        await call(base, 'POST', '/api/v1/customers/me/palm/enroll', {
          token: brokeToken,
          body: enrollBody('nour', protectionKey)
        })
      );
      expect(enr.ok, `enroll ${errCode(enr)}`);
      const r = note(
        await call(base, 'POST', '/api/v1/payments/authorize', {
          token: merchToken,
          body: { requestId: randomUUID(), timestamp: iso(), amountPiasters: 2_000, probe: probeBody('nour', protectionKey) }
        })
      );
      expect(r.status === 422 && errCode(r) === 'INSUFFICIENT_FUNDS', `${r.status} ${errCode(r)}`);
      return 'declined correctly';
    });

    await step('refund by owning merchant restores customer', async () => {
      const cBefore = await walletOf();
      const r = note(
        await call(base, 'POST', `/api/v1/transactions/${payRef}/refund`, {
          token: merchToken,
          body: { requestId: randomUUID(), timestamp: iso(), reason: 'e2e refund' }
        })
      );
      expect(r.ok && r.data?.status === 'refunded', `${r.status} ${errCode(r)}`);
      expect((await walletOf()) === cBefore + 12_000, 'customer not restored');
      return payRef;
    });

    await step('SECOND refund attempt → REFUND_NOT_ALLOWED', async () => {
      const r = note(
        await call(base, 'POST', `/api/v1/transactions/${payRef}/refund`, {
          token: merchToken,
          body: { requestId: randomUUID(), timestamp: iso(), reason: 'double spend?' }
        })
      );
      expect(r.status === 422 && errCode(r) === 'REFUND_NOT_ALLOWED', `${r.status} ${errCode(r)}`);
      return errCode(r);
    });

    await step('both histories show the flow with masked counterparties', async () => {
      const ch = note(await call(base, 'GET', '/api/v1/customers/me/transactions?limit=50', { token: custToken }));
      const items = (ch.data?.items ?? []) as Array<{ type: string; signedAmountPiasters: number; counterparty?: { maskedPhone?: string } | null }>;
      expect(items.some((t) => t.type === 'payment' && t.signedAmountPiasters < 0), 'no negative payment for customer');
      expect(items.some((t) => t.type === 'refund' && t.signedAmountPiasters > 0), 'no refund credit for customer');
      expect(items.some((t) => t.counterparty?.maskedPhone?.includes('•••')), 'counterparty not masked');
      const mh = note(await call(base, 'GET', '/api/v1/merchants/me/transactions?limit=50', { token: merchToken }));
      const mitems = (mh.data?.items ?? []) as Array<{ type: string; signedAmountPiasters: number }>;
      expect(mitems.some((t) => t.type === 'payment' && t.signedAmountPiasters > 0), 'no takings for merchant');
      expect(mitems.some((t) => t.type === 'refund' && t.signedAmountPiasters < 0), 'no refund debit for merchant');
      return `${items.length} customer / ${mitems.length} merchant rows`;
    });

    await step('invariants hold after all activity', async () => {
      const r = note(await call(base, 'GET', '/api/v1/dev/invariants', { devToken: ctx.config.devToken }));
      expect(r.data?.ok === true, JSON.stringify(r.raw).slice(0, 200));
      return 'ledger balanced, balances derived, templates consistent';
    });

    await step('audit hash chain intact', async () => {
      const r = note(await call(base, 'GET', '/api/v1/dev/audit/verify', { devToken: ctx.config.devToken }));
      expect(r.data?.ok === true, `broken at seq ${r.data?.brokenAtSeq ?? '?'}`);
      return `${String(r.data?.checked)} events verified`;
    });

    await step('PRIVACY GREP — no descriptors/ciphertext/PINs/key bytes in any response', async () => {
      // 'protectionKey' must never appear outside the single by-design
      // key-delivery response, which is excluded from the corpus at fetch time.
      const forbidden = ['pin_hash', 'pinHash', '"vec"', 'descriptor"', 'ciphertext', 'key_id', 'protectionKey', 'storageKey'];
      const leaks: string[] = [];
      for (const body of bodies) {
        for (const needle of forbidden) {
          if (body.includes(needle)) leaks.push(`${needle} in ${body.slice(0, 120)}`);
        }
      }
      expect(leaks.length === 0, leaks.slice(0, 3).join(' | '));
      return `${bodies.length} responses scanned`;
    });
  } finally {
    await server.close();
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* temp cleanup best-effort */
    }
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} steps passed`);
  if (failed.length > 0) {
    console.log('\nFailed steps:');
    for (const f of failed) console.log(`  ✗ ${f.name}: ${f.note}`);
    process.exitCode = 1;
  } else {
    console.log('\nE2E PASSED — full scan & pay cycle works end-to-end (SIMULATED).');
  }
}

main().catch((err) => {
  console.error('e2e crashed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
