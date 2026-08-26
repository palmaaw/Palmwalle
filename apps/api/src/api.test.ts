/**
 * API integration tests over fastify.inject with an in-memory database and the
 * REAL biometric pipeline (synthetic captures through extraction/protection).
 * Covers: auth & throttling, wallet flows, the replay/idempotency matrix,
 * wrong-palm rejection, insufficient funds, owner-scoped refunds, privacy
 * greps, and concurrent-duplicate settlement.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ENROLL_FRAMES_REQUIRED,
  MAX_DEPOSIT_PIASTERS,
  MAX_PAYMENT_PIASTERS,
  MIN_DEPOSIT_PIASTERS,
  MIN_PAYMENT_PIASTERS
} from '@palmwallet/shared';
import type { QualityReportDTO } from '@palmwallet/shared';
import {
  SyntheticCaptureSource,
  buildEnrollmentCode,
  buildProbeCode,
  demoSeed,
  extractFromGray,
  renderSyntheticPalm
} from '@palmwallet/biometrics';
import type { AppConfig } from './config.js';
import { buildContext } from './container.js';
import type { AppContext } from './container.js';
import { buildApp } from './server.js';

function testConfig(): AppConfig {
  return {
    nodeEnv: 'test',
    demoMode: true,
    host: '127.0.0.1',
    port: 0,
    logLevel: 'error',
    databasePath: ':memory:',
    // Fixed test keys (NOT secrets) so every run is deterministic.
    jwtSecretB64: Buffer.alloc(32, 3).toString('base64'),
    templateMasterKeyB64: Buffer.alloc(32, 4).toString('base64'),
    templateKeyId: 'k1',
    freshnessWindowMs: 5 * 60_000,
    minPaymentPiasters: MIN_PAYMENT_PIASTERS,
    maxPaymentPiasters: MAX_PAYMENT_PIASTERS,
    minDepositPiasters: MIN_DEPOSIT_PIASTERS,
    maxDepositPiasters: MAX_DEPOSIT_PIASTERS,
    jwtTtlSeconds: 3600,
    devSetupToken: 'setup-test-token',
    devToken: 'dev-test-token',
    corsOrigins: '*'
  };
}

// ---------------------------------------------------------------------------
// Synthetic capture helpers — the SAME pipeline the frontends use.
// ---------------------------------------------------------------------------

const QUALITY: QualityReportDTO = {
  score: 0.92,
  usable: true,
  brightness: 0.5,
  contrast: 0.9,
  sharpness: 0.9,
  hints: ['ok']
};

/** Enrollment body with an ON-DEVICE-protected code (same flow as the PWA). */
function enrollBody(slug: string, protectionKey: Uint8Array): Record<string, unknown> {
  const src = new SyntheticCaptureSource(demoSeed(slug), { size: 128 });
  const vectors = src.captureEnrollmentFrames().map((f) => extractFromGray(f).vector);
  expect(vectors.length).toBe(ENROLL_FRAMES_REQUIRED);
  const built = buildEnrollmentCode(vectors, protectionKey);
  return { code: built.code, quality: QUALITY, consistencyScore: built.consistencyScore, capture: { source: 'synthetic', frames: ENROLL_FRAMES_REQUIRED } };
}

/** Probe code like a POS scan: frames fused + protected on-device. */
function probeBody(slug: string, protectionKey: Uint8Array): Record<string, unknown> {
  const src = new SyntheticCaptureSource(demoSeed(slug), { size: 128 });
  const vectors = src.captureProbeFrames().map((f) => extractFromGray(f).vector);
  const built = buildProbeCode(vectors, protectionKey);
  return { code: built, quality: QUALITY };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let app: ReturnType<typeof buildApp>;
let ctx: AppContext;
let protectionKey!: Uint8Array;

beforeAll(async () => {
  const config = testConfig();
  ctx = await buildContext(config);
  app = buildApp(ctx);
  await app.ready();
  // The device-visible subkey the tests use to protect codes client-side.
  protectionKey = Buffer.from(ctx.biometrics.protectionKeyB64, 'base64');
});

afterAll(async () => {
  await app.close();
  ctx.db.close();
});

type Res = Awaited<ReturnType<typeof app.inject>>;

function expectOk(res: Res): Record<string, unknown> {
  expect(res.statusCode).toBeLessThan(500);
  const body = res.json() as { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };
  if (!body.ok) throw new Error(`expected ok response, got ${res.statusCode} ${JSON.stringify(body.error)}`);
  return body.data ?? {};
}

async function registerCustomer(name: string, phone: string, password = 'test1234'): Promise<{ token: string; id: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/customers/register',
    payload: { name, phone, password }
  });
  const data = expectOk(res);
  const customer = data.customer as { id: string };
  return { token: data.accessToken as string, id: customer.id };
}

async function authed<T extends Record<string, unknown>>(res: Promise<Res> | Res): Promise<T> {
  return expectOk(await res) as T;
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

let n = 0;
const uniqPhone = (): string => `+2010${String(++n).padStart(8, '0')}`;

describe('health & meta', () => {
  it('reports up and discloses SIMULATED biometrics', async () => {
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    const meta = await authed(app.inject({ method: 'GET', url: '/api/v1/meta' }));
    expect(meta.biometrics).toMatchObject({ simulated: true });
    expect(meta.prototype).toBe(true);
  });
});

describe('customer registration & login', () => {
  it('validates Egyptian phone numbers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customers/register',
      payload: { name: 'Bad Phone', phone: '+2012345678901', password: 'test1234' }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('registers, then rejects duplicate phone', async () => {
    const phone = uniqPhone();
    const first = await registerCustomer('First', phone);
    expect(first.token).toBeTruthy();
    const dup = await app.inject({ method: 'POST', url: '/api/v1/customers/register', payload: { name: 'Dup', phone, password: 'test1234' } });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('ACCOUNT_EXISTS');
  });

  it('throttles repeated wrong passwords then accepts the right one later', async () => {
    const phone = uniqPhone();
    await registerCustomer('Throttled', phone, 'right-passphrase');
    for (let i = 0; i < 5; i++) {
      const bad = await app.inject({ method: 'POST', url: '/api/v1/auth/customer/login', payload: { phone, password: 'wrong-password' } });
      expect(bad.statusCode).toBe(401);
    }
    const sixth = await app.inject({ method: 'POST', url: '/api/v1/auth/customer/login', payload: { phone, password: 'right-passphrase' } });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error.code).toBe('RATE_LIMITED');
    ctx.throttle.clear(`cust:${phone}:127.0.0.1`);
    const good = await app.inject({ method: 'POST', url: '/api/v1/auth/customer/login', payload: { phone, password: 'right-passphrase' } });
    expect(good.statusCode).toBe(200);
  });

  it('rejects passwords shorter than 6 characters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customers/register',
      payload: { name: 'Short Pass', phone: uniqPhone(), password: '12345' }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('requires auth on /me', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/customers/me' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('AUTH_REQUIRED');
  });
});

describe('deposits: provider sim + idempotent replays', () => {
  let token = '';

  beforeAll(async () => {
    ({ token } = await registerCustomer('Depositor', uniqPhone()));
  });

  async function deposit(requestId: string, amountPiasters: number, offsetMs = 0, source = 'instapay_sim') {
    return app.inject({
      method: 'POST',
      url: '/api/v1/customers/me/deposits',
      headers: bearer(token),
      payload: { requestId, timestamp: iso(offsetMs), amountPiasters, source }
    });
  }

  it('rejects stale timestamps', async () => {
    const res = await deposit(crypto.randomUUID(), 100_00, -6 * 60_000);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('REQUEST_STALE');
  });

  it('completes a top-up and credits the wallet', async () => {
    const data = await authed(deposit(crypto.randomUUID(), 250_00));
    expect(data.status).toBe('completed');
    expect((data.wallet as { balancePiasters: number }).balancePiasters).toBe(250_00);
  });

  it('replays the ORIGINAL response without re-settling', async () => {
    const requestId = crypto.randomUUID();
    const first = await authed(deposit(requestId, 100_00));
    const again = await authed(deposit(requestId, 100_00));
    expect(again.replayed).toBe(true);
    expect((first.wallet as { balancePiasters: number }).balancePiasters).toBe(
      (again.wallet as { balancePiasters: number }).balancePiasters
    );
  });

  it('rejects a reused requestId carrying DIFFERENT content', async () => {
    const requestId = crypto.randomUUID();
    await authed(deposit(requestId, 100_00));
    const mutated = await deposit(requestId, 900_00);
    expect(mutated.statusCode).toBe(409);
    expect(mutated.json().error.code).toBe('REQUEST_REPLAY_PAYLOAD_MISMATCH');
  });

  it('surfaces simulated provider failures as 502 with NO money movement', async () => {
    const before = await authed(
      app.inject({ method: 'GET', url: '/api/v1/customers/me/wallet', headers: bearer(token) })
    );
    // Nil-uuid sentinel triggers the SIMULATED outage (still schema-valid).
    const res = await deposit('00000000-0000-4000-8000-000000000001', 50_00);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('PROVIDER_FAILED');
    const after = await authed(
      app.inject({ method: 'GET', url: '/api/v1/customers/me/wallet', headers: bearer(token) })
    );
    expect((after.wallet as { balancePiasters: number }).balancePiasters).toBe(
      (before.wallet as { balancePiasters: number }).balancePiasters
    );
  });

  it('enforces deposit bounds', async () => {
    const low = await deposit(crypto.randomUUID(), 99);
    expect(low.statusCode).toBe(400);
    const high = await deposit(crypto.randomUUID(), MAX_DEPOSIT_PIASTERS * 10);
    expect(high.statusCode).toBe(400);
  });
});

describe('palm lifecycle', () => {
  let token = '';

  beforeAll(async () => {
    ({ token } = await registerCustomer('Palmy', uniqPhone()));
  });

  it('delivers the protection subkey only to authenticated sessions', async () => {
    const anon = await app.inject({ method: 'GET', url: '/api/v1/biometrics/protection-key' });
    expect(anon.statusCode).toBe(401);

    const ok = await authed(
      app.inject({ method: 'GET', url: '/api/v1/biometrics/protection-key', headers: bearer(token) })
    ) as unknown as { algoId: string; bits: number; protectionKeyB64: string };
    expect(ok.algoId).toBe('palmwallet-sim-hog-v1');
    expect(ok.bits).toBe(1024);
    expect(Buffer.from(ok.protectionKeyB64, 'base64').length).toBe(32);
    // Purpose separation: the device-visible subkey must never be the raw
    // master (and can never unseal stored templates — covered in unit tests).
    const deviceKeyHex = Buffer.from(ok.protectionKeyB64, 'base64').toString('hex');
    expect(deviceKeyHex).not.toBe(Buffer.alloc(32, 4).toString('hex'));
  });

  it('rejects malformed codes with BIOMETRIC_UNSUPPORTED_ALGO', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/customers/me/palm/enroll',
      headers: bearer(token),
      payload: {
        code: { algoId: 'palmwallet-sim-hog-v1', version: 1, bits: Buffer.alloc(10).toString('base64') },
        quality: QUALITY,
        consistencyScore: 0.9,
        capture: { source: 'synthetic', frames: 5 }
      }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BIOMETRIC_UNSUPPORTED_ALGO');
  });

  it('enrolls, reports status, self-tests positive and negative', async () => {
    const enrollRes = await app.inject({
      method: 'POST',
      url: '/api/v1/customers/me/palm/enroll',
      headers: bearer(token),
      payload: enrollBody('aya', protectionKey)
    });
    expect(enrollRes.statusCode).toBe(200);
    const enrolled = expectOk(enrollRes) as unknown as { enrolled: boolean; consistencyScore: number };
    expect(enrolled.enrolled).toBe(true);

    const status = await authed(
      app.inject({ method: 'GET', url: '/api/v1/customers/me/palm/status', headers: bearer(token) })
    ) as unknown as { enrolled: boolean };
    expect(status.enrolled).toBe(true);

    const selfOk = await authed(
      app.inject({
        method: 'POST',
        url: '/api/v1/customers/me/palm/self-test',
        headers: bearer(token),
        payload: { probe: probeBody('aya', protectionKey) }
      })
    ) as unknown as { decision: string; score: number };
    expect(selfOk.decision).toBe('match');

    const selfBad = await authed(
      app.inject({
        method: 'POST',
        url: '/api/v1/customers/me/palm/self-test',
        headers: bearer(token),
        payload: { probe: probeBody('stranger-selftest', protectionKey) }
      })
    ) as unknown as { decision: string };
    expect(selfBad.decision).toBe('no_match');
  });

  it('deletes the palm only with the right password', async () => {
    const wrong = await app.inject({
      method: 'DELETE',
      url: '/api/v1/customers/me/palm',
      headers: bearer(token),
      payload: { password: 'wrong-password' }
    });
    expect(wrong.statusCode).toBe(401);
    // Re-enroll was done in previous test; delete with correct password.
    const ok = await app.inject({
      method: 'DELETE',
      url: '/api/v1/customers/me/palm',
      headers: bearer(token),
      payload: { password: 'test1234' }
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.deleted).toBe(true);
    const status = await authed(
      app.inject({ method: 'GET', url: '/api/v1/customers/me/palm/status', headers: bearer(token) })
    ) as unknown as { enrolled: boolean };
    expect(status.enrolled).toBe(false);
  });
});

describe('scan & pay end-to-end', () => {
  let custA = ''; let custB = '';
  let merchToken = ''; let otherMerchToken = '';
  const MERCHANT_CODE = 'TEST-SHOP';

  beforeAll(async () => {
    custA = (await registerCustomer('Aya Payer', uniqPhone())).token;
    custB = (await registerCustomer('Broke Broke', uniqPhone())).token;
    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/v1/merchants/register',
      headers: { 'x-setup-token': 'setup-test-token' },
      payload: { name: 'Test Shop', code: MERCHANT_CODE, phone: uniqPhone(), password: 'shop-secret-1' }
    });
    expect(setupRes.statusCode).toBe(200);
    merchToken = (setupRes.json().data as { accessToken: string }).accessToken;

    const other = await app.inject({
      method: 'POST',
      url: '/api/v1/merchants/register',
      headers: { 'x-setup-token': 'setup-test-token' },
      payload: { name: 'Other Shop', code: 'OTHER-SHOP', phone: uniqPhone(), password: 'other-secret' }
    });
    otherMerchToken = (other.json().data as { accessToken: string }).accessToken;

    // Setup-token guard:
    const guarded = await app.inject({
      method: 'POST',
      url: '/api/v1/merchants/register',
      payload: { name: 'X', code: 'NO-TOKEN', phone: uniqPhone(), password: 'test1234' }
    });
    expect(guarded.statusCode).toBe(403);

    // Fund Aya; leave custB at zero. Enroll both palms through the REAL service.
    await authed(app.inject({
      method: 'POST',
      url: '/api/v1/customers/me/deposits',
      headers: bearer(custA),
      payload: { requestId: crypto.randomUUID(), timestamp: iso(), amountPiasters: 300_00, source: 'instapay_sim' }
    }));
    await authed(app.inject({
      method: 'POST',
      url: '/api/v1/customers/me/palm/enroll',
      headers: bearer(custA),
      payload: enrollBody('omar', protectionKey)
    }));
    await authed(app.inject({
      method: 'POST',
      url: '/api/v1/customers/me/palm/enroll',
      headers: bearer(custB),
      payload: enrollBody('nour', protectionKey)
    }));
  });

  function authorize(requestId: string, amountPiasters: number, slug: string, offsetMs = 0) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/payments/authorize',
      headers: bearer(merchToken),
      payload: { requestId, timestamp: iso(offsetMs), amountPiasters, probe: probeBody(slug, protectionKey) }
    });
  }

  it('settles a matching palm atomically and moves BOTH wallets', async () => {
    const merchBefore = (await authed(
      app.inject({ method: 'GET', url: '/api/v1/merchants/me/wallet', headers: bearer(merchToken) })
    )).wallet as { balancePiasters: number };

    const data = await authed(authorize(crypto.randomUUID(), 120_00, 'omar'));

    expect(data.status).toBe('completed');
    const match = data.match as { outcome: string; threshold: number; similarityBand?: string; score?: number };
    expect(match.outcome).toBe('match');
    // Score-oracle hygiene: payment responses carry bands, never raw scores.
    expect(match.similarityBand).toBe('high');
    expect(match.score).toBeUndefined();
    expect((data.customer as { displayName: string }).displayName).toBe('Aya Payer');
    const custWallet = data.wallet as { balancePiasters: number };
    expect(custWallet.balancePiasters).toBe(180_00);

    const merchAfter = (await authed(
      app.inject({ method: 'GET', url: '/api/v1/merchants/me/wallet', headers: bearer(merchToken) })
    )).wallet as { balancePiasters: number };
    expect(merchAfter.balancePiasters - merchBefore.balancePiasters).toBe(120_00);

    // Histories show the movement with counterparties masked.
    const merchHist = (await authed(
      app.inject({ method: 'GET', url: '/api/v1/merchants/me/transactions', headers: bearer(merchToken) })
    )).items as Array<{ type: string; signedAmountPiasters: number; counterparty: { displayName: string; maskedPhone: string } | null }>;
    const payRow = merchHist.find((t) => t.type === 'payment')!;
    expect(payRow.signedAmountPiasters).toBe(120_00);
    expect(payRow.counterparty?.maskedPhone).toMatch(/•••/);
  });

  it('is idempotent under sequential replay', async () => {
    const requestId = crypto.randomUUID();
    const first = await authed(authorize(requestId, 30_00, 'omar'));
    const replay = await authed(authorize(requestId, 30_00, 'omar'));
    expect(replay.replayed).toBe(true);
    expect((first.transaction as { ref: string }).ref).toBe((replay.transaction as { ref: string }).ref);
  });

  it('collapses CONCURRENT duplicate submissions onto exactly one settlement', async () => {
    const merchBefore = (await authed(
      app.inject({ method: 'GET', url: '/api/v1/merchants/me/wallet', headers: bearer(merchToken) })
    )).wallet as { balancePiasters: number };

    const requestId = crypto.randomUUID();
    const payload = { requestId, timestamp: iso(), amountPiasters: 20_00, probe: probeBody('omar', protectionKey) };
    const [r1, r2] = await Promise.all([
      app.inject({ method: 'POST', url: '/api/v1/payments/authorize', headers: bearer(merchToken), payload }),
      app.inject({ method: 'POST', url: '/api/v1/payments/authorize', headers: bearer(merchToken), payload: { ...payload } })
    ]);
    for (const r of [r1, r2]) expect(r.statusCode).toBe(200);
    const d1 = r1.json().data as { status: string; transaction: { ref: string }; replayed?: boolean };
    const d2 = r2.json().data as { status: string; transaction: { ref: string }; replayed?: boolean };
    expect(d1.status).toBe('completed');
    expect(d2.status).toBe('completed');
    // Same settlement surfaced twice — one of them flagged as the replay.
    expect(d1.transaction.ref).toBe(d2.transaction.ref);
    expect([d1.replayed === true, d2.replayed === true].filter(Boolean).length).toBe(1);

    const merchAfter = (await authed(
      app.inject({ method: 'GET', url: '/api/v1/merchants/me/wallet', headers: bearer(merchToken) })
    )).wallet as { balancePiasters: number };
    expect(merchAfter.balancePiasters - merchBefore.balancePiasters).toBe(20_00);
  });

  it('returns 200 rejected for an unknown palm with ZERO movement', async () => {
    const merchBefore = (await authed(
      app.inject({ method: 'GET', url: '/api/v1/merchants/me/wallet', headers: bearer(merchToken) })
    )).wallet as { balancePiasters: number };
    const res = await authorize(crypto.randomUUID(), 10_00, 'unknown-stranger');
    expect(res.statusCode).toBe(200);
    const body = res.json().data as { status: string; code: string; match: { outcome: string } };
    expect(body.status).toBe('rejected');
    expect(body.code).toBe('BIOMETRIC_NO_MATCH');
    const merchAfter = (await authed(
      app.inject({ method: 'GET', url: '/api/v1/merchants/me/wallet', headers: bearer(merchToken) })
    )).wallet as { balancePiasters: number };
    expect(merchAfter.balancePiasters).toBe(merchBefore.balancePiasters);
  });

  it('declines when funds are insufficient (422)', async () => {
    const res = await authorize(crypto.randomUUID(), 15_00, 'nour'); // custB has zero
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('refunds once, restores the customer, refuses repeats and strangers', async () => {
    // Pay, then refund by owner.
    const payData = await authed(authorize(crypto.randomUUID(), 45_00, 'omar'));
    const ref = (payData.transaction as { ref: string }).ref;

    const refund = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${ref}/refund`,
      headers: bearer(merchToken),
      payload: { requestId: crypto.randomUUID(), timestamp: iso(), reason: 'changed mind' }
    });
    expect(refund.statusCode).toBe(200);
    expect(refund.json().data.status).toBe('refunded');

    const custHist = (await authed(
      app.inject({ method: 'GET', url: '/api/v1/customers/me/transactions', headers: bearer(custA) })
    )).items as Array<{ type: string; signedAmountPiasters: number; parentRef: string | null }>;
    const refundRow = custHist.find((t) => t.type === 'refund')!;
    expect(refundRow.signedAmountPiasters).toBe(45_00);
    expect(refundRow.parentRef).toBe(ref);

    // Second refund attempt -> refused even with a fresh requestId.
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${ref}/refund`,
      headers: bearer(merchToken),
      payload: { requestId: crypto.randomUUID(), timestamp: iso() }
    });
    expect(again.statusCode).toBe(422);
    expect(again.json().error.code).toBe('REFUND_NOT_ALLOWED');

    // Another merchant cannot refund someone else's sale.
    const payData2 = await authed(authorize(crypto.randomUUID(), 5_00, 'omar'));
    const ref2 = (payData2.transaction as { ref: string }).ref;
    const foreign = await app.inject({
      method: 'POST',
      url: `/api/v1/transactions/${ref2}/refund`,
      headers: bearer(otherMerchToken),
      payload: { requestId: crypto.randomUUID(), timestamp: iso() }
    });
    expect(foreign.statusCode).toBe(403);
  });
});

describe('privacy greps', () => {
  it('never leaks descriptors, ciphertext or password material in any response', async () => {
    // Exercise a broad slice of the surface and collect bodies.
    const bodies: string[] = [];
    const push = async (p: Promise<Res>): Promise<void> => {
      bodies.push((await p).body);
    };
    const phone = uniqPhone();
    const reg = await registerCustomer('Grep Me', phone);
    await push(app.inject({ method: 'GET', url: '/api/v1/customers/me', headers: bearer(reg.token) }));
    await push(app.inject({ method: 'GET', url: '/api/v1/customers/me/wallet', headers: bearer(reg.token) }));
    await push(app.inject({
      method: 'POST',
      url: '/api/v1/customers/me/deposits',
      headers: bearer(reg.token),
      payload: { requestId: crypto.randomUUID(), timestamp: iso(), amountPiasters: 10_00, source: 'vodafone_cash_sim' }
    }));
    await push(app.inject({
      method: 'POST',
      url: '/api/v1/customers/me/palm/enroll',
      headers: bearer(reg.token),
      payload: enrollBody('grep-slug', protectionKey)
    }));
    await push(app.inject({ method: 'GET', url: '/api/v1/customers/me/palm/status', headers: bearer(reg.token) }));
    await push(app.inject({ method: 'GET', url: '/api/v1/customers/me/transactions', headers: bearer(reg.token) }));

    const forbidden = [
      'password_hash',
      'passwordHash',
      'pin_hash',
      'pinHash',
      'ciphertext',
      '"vec"',
      'descriptor',
      'key_id',
      'keyId',
      'protectionKey',
      'storageKey'
    ];
    for (const body of bodies) {
      for (const needle of forbidden) {
        expect(body.includes(needle), `response leaked "${needle}": ${body.slice(0, 300)}`).toBe(false);
      }
    }

    // Audit trail stores outcomes/scores only.
    const tail = await app.inject({
      method: 'GET',
      url: '/api/v1/dev/audit/tail?limit=100',
      headers: { 'x-dev-token': 'dev-test-token' }
    });
    expect(tail.statusCode).toBe(200);
    expect(tail.body.includes('grep-slug')).toBe(false);
  });
});

describe('dev diagnostics', () => {
  it('guard themselves and verify integrity', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/v1/dev/invariants' });
    expect(denied.statusCode).toBe(403);

    const inv = await app.inject({ method: 'GET', url: '/api/v1/dev/invariants', headers: { 'x-dev-token': 'dev-test-token' } });
    expect(inv.statusCode).toBe(200);
    expect(inv.json().data.ok).toBe(true);

    const chain = await app.inject({ method: 'GET', url: '/api/v1/dev/audit/verify', headers: { 'x-dev-token': 'dev-test-token' } });
    expect(chain.json().data.ok).toBe(true);
    expect(chain.json().data.checked).toBeGreaterThan(0);
  });

  it('renderSyntheticPalm stays available for the E2E harness', () => {
    expect(renderSyntheticPalm(demoSeed('smoke'), {}).width).toBeGreaterThan(0);
  });
});
