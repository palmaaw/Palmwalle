/**
 * Seed the demo database (idempotent upserts). REFUSED in production.
 *
 * ⚠️ SIMULATED environment: balances come from a seeded system float, and the
 * demo palms are enrolled through the REAL (but simulated) biometric pipeline
 * from SyntheticCaptureSource — the same generator the apps use in dev mode.
 *
 * Demo identities are the cross-app contract (demoSeed slugs):
 *   aya / omar / nour  → customers, password demo1234
 *   ZAMALEK-COFFEE     → merchant, password shop2468
 */

import { buildContext, hashPassword, loadConfig } from '@palmwallet/api';
import { newHumanRef, newId } from '@palmwallet/shared';
import { buildEnrollmentCode, decodeCode } from '@palmwallet/biometrics';
import type { WalletAccountRow } from '@palmwallet/db';

import { DEMO_QUALITY, enrollmentFrames, protectionKeyOf } from './lib.js';

const MERCHANT = {
  code: 'ZAMALEK-COFFEE',
  name: 'Zamalek Coffee',
  phone: '+201200000001',
  password: 'shop2468',
  targetPiasters: 500_000
};

const CUSTOMERS = [
  { slug: 'aya', name: 'Aya Hassan', phone: '+201000000001', password: 'demo1234', targetPiasters: 250_000 },
  { slug: 'omar', name: 'Omar Khaled', phone: '+201000000002', password: 'demo1234', targetPiasters: 80_000 },
  // Nour intentionally starts at ZERO for the insufficient-funds demo.
  { slug: 'nour', name: 'Nour Adel', phone: '+201000000003', password: 'demo1234', targetPiasters: 0 }
];

function egp(piasters: number): string {
  return `EGP ${(piasters / 100).toLocaleString('en-EG', { minimumFractionDigits: 2 })}`;
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.nodeEnv === 'production') {
    console.error('refusing to seed a production environment');
    process.exit(1);
  }

  const ctx = await buildContext(config);
  const protectionKey = protectionKeyOf(ctx);

  /** Demo float: one real double-entry deposit from the system topup_source. */
  const fundTo = (account: WalletAccountRow, target: number, label: string): number | null => {
    const deficit = target - account.balancePiasters;
    if (deficit <= 0) return null;
    return ctx.db.withTransaction(() => {
      const sys = ctx.repos.accounts.ensureForOwner({ ownerType: 'system', ownerId: 'topup_source' });
      const id = newId();
      ctx.repos.txns.insert({
        id,
        humanRef: newHumanRef('DP'),
        type: 'deposit',
        amountPiasters: deficit,
        customerAccountId: account.ownerType === 'customer' ? account.id : null,
        merchantAccountId: account.ownerType === 'merchant' ? account.id : null,
        provider: 'seed_float',
        providerRef: `SEED-${id.slice(0, 8)}`,
        requestId: null,
        metaJson: '{}'
      });
      ctx.repos.ledgerEntries.post(id, [
        { accountId: sys.id, direction: 'debit', amountPiasters: deficit, memo: `seed float → ${label}` },
        { accountId: account.id, direction: 'credit', amountPiasters: deficit, memo: `seed float → ${label}` }
      ]);
      ctx.repos.txns.updateStatus(id, 'completed');
      ctx.repos.audit.append({
        actorType: 'system',
        actorId: 'seed',
        event: 'wallet.seed_topup',
        subjectType: 'account',
        subjectId: account.id,
        outcome: 'ok',
        data: { ref: ctx.repos.txns.getById(id)?.humanRef, amountPiasters: deficit }
      });
      return deficit;
    });
  };

  // --- Merchant ------------------------------------------------------------
  let merchant = ctx.repos.merchants.getByCode(MERCHANT.code);
  if (!merchant) {
    const id = newId();
    ctx.repos.merchants.insert({
      id,
      code: MERCHANT.code,
      name: MERCHANT.name,
      phone: MERCHANT.phone,
      passwordHash: hashPassword(MERCHANT.password)
    });
    ctx.repos.accounts.ensureForOwner({ ownerType: 'merchant', ownerId: id });
    ctx.repos.audit.append({
      actorType: 'system',
      actorId: 'seed',
      event: 'merchant.registered',
      subjectType: 'merchant',
      subjectId: id,
      data: { code: MERCHANT.code }
    });
    merchant = ctx.repos.merchants.getById(id)!;
  }
  const merchAccount = ctx.repos.accounts.ensureForOwner({ ownerType: 'merchant', ownerId: merchant.id });
  fundTo(merchAccount, MERCHANT.targetPiasters, MERCHANT.code);

  // --- Customers + palms ---------------------------------------------------
  for (const demo of CUSTOMERS) {
    let c = ctx.repos.customers.getByPhone(demo.phone);
    if (!c) {
      const id = newId();
      ctx.repos.customers.insert({ id, phone: demo.phone, name: demo.name, passwordHash: hashPassword(demo.password) });
      ctx.repos.accounts.ensureForOwner({ ownerType: 'customer', ownerId: id });
      ctx.repos.audit.append({
        actorType: 'system',
        actorId: 'seed',
        event: 'customer.registered',
        subjectType: 'customer',
        subjectId: id
      });
      c = ctx.repos.customers.getById(id)!;
    }
    const account = ctx.repos.accounts.ensureForOwner({ ownerType: 'customer', ownerId: c.id });
    fundTo(account, demo.targetPiasters, demo.slug);

    // Palm enrollment through the REAL service — same shape as the wire: frames
    // are fused + protected into a one-way code HERE (device-side), and only
    // that code is handed to the server for sealing.
    const existing = await ctx.templates.getBySubject('customer', c.id);
    let enrolled = existing.length > 0;
    if (!enrolled) {
      const built = buildEnrollmentCode(enrollmentFrames(demo.slug), protectionKey);
      const result = await ctx.biometrics.enrollPalm({
        subjectType: 'customer',
        subjectId: c.id,
        code: decodeCode(built.code),
        quality: DEMO_QUALITY,
        captureSource: 'synthetic',
        consistencyScore: built.consistencyScore
      });
      ctx.repos.audit.append({
        actorType: 'customer',
        actorId: c.id,
        event: 'palm.enrolled',
        subjectType: 'customer',
        subjectId: c.id,
        data: { templateId: result.templateId, source: 'synthetic', seeded: true }
      });
      enrolled = true;
    }
    const balance = ctx.repos.accounts.getById(account.id)!.balancePiasters;
    console.log(`seeded ${demo.name.padEnd(12)} ${demo.phone}  password ${demo.password}  ${egp(balance).padStart(14)}  palm=${enrolled ? 'enrolled' : 'MISSING'}`);
  }

  const merchBalance = ctx.repos.accounts.getById(merchAccount.id)!.balancePiasters;
  console.log(`seeded ${MERCHANT.name.padEnd(12)} ${MERCHANT.code}  password ${MERCHANT.password}  ${egp(merchBalance).padStart(14)}  (POS)`);

  console.log('\n⚠️  SIMULATED PROTOTYPE — no real financial rails, simulated biometrics.');
  console.log(`   API: http://localhost:${config.port}   POS login: ${MERCHANT.code} / ${MERCHANT.password}`);
  console.log(`   Extra merchants need the setup token: ${config.devSetupToken}`);

  ctx.db.close();
}

main().catch((err) => {
  console.error('seed failed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
