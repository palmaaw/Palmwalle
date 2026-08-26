import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { newId } from '@palma/shared';
import { PalmaDatabase, nowIso } from './database.js';
import { runMigrations, sha256Hex } from './migrator.js';
import { AccountRepo, AuditRepo, CustomerRepo, IdempotencyRepo, LedgerRepo, SqliteTemplateStore, TransactionRepo, assertInvariants, collectInvariants } from './index.js';

function freshDb(): PalmaDatabase {
  const db = new PalmaDatabase(':memory:');
  runMigrations(db);
  return db;
}

/** Two funded accounts + a completed payment between them; returns ids. */
function seedPayment(db: PalmaDatabase, amountA = 500): { a: string; b: string; txn: string } {
  const accounts = new AccountRepo(db);
  const txns = new TransactionRepo(db);
  const ledger = new LedgerRepo(db);
  const a = accounts.createForOwner({ ownerType: 'customer', ownerId: 'cust-a' }).id;
  const b = accounts.createForOwner({ ownerType: 'merchant', ownerId: 'merch-b' }).id;
  const fundTxn = newId();
  txns.insert({ id: fundTxn, humanRef: 'DP-TEST-0001', type: 'deposit', amountPiasters: amountA, customerAccountId: a });
  const sys = accounts.ensureForOwner({ ownerType: 'system', ownerId: 'topup_source' }).id;
  ledger.post(fundTxn, [
    { accountId: sys, direction: 'debit', amountPiasters: amountA },
    { accountId: a, direction: 'credit', amountPiasters: amountA }
  ]);
  txns.updateStatus(fundTxn, 'completed');

  const payTxn = newId();
  txns.insert({ id: payTxn, humanRef: 'PM-TEST-0001', type: 'payment', amountPiasters: 200, customerAccountId: a, merchantAccountId: b });
  ledger.post(payTxn, [
    { accountId: a, direction: 'debit', amountPiasters: 200, memo: 'payment' },
    { accountId: b, direction: 'credit', amountPiasters: 200, memo: 'payment' }
  ]);
  txns.updateStatus(payTxn, 'completed');
  assertInvariants(db);
  return { a, b, txn: payTxn };
}

describe('migrations', () => {
  it('apply once and are idempotent on re-run', () => {
    const db = freshDb();
    const first = runMigrations(db);
    expect(first.length).toBeGreaterThanOrEqual(2);
    const second = runMigrations(db); // no-op
    expect(second).toEqual(first);
    db.close();
  });

  it('refuse to run when an applied file drifts', () => {
    const db = freshDb();
    db.stmt("UPDATE _migrations SET checksum = 'deadbeef' WHERE name LIKE '0001%'").run();
    expect(() => runMigrations(db)).toThrow(/drift/);
    db.close();
  });

  it('record stable checksums (sha256 of file content)', () => {
    const db = freshDb();
    const rows = db.stmt('SELECT name, checksum FROM _migrations ORDER BY name').all() as Array<{ name: string; checksum: string }>;
    for (const r of rows) expect(r.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex('x')).toBe(sha256Hex('x'));
    db.close();
  });
});

describe('ledger + triggers', () => {
  it('move balances only via entries, recording balance_after', () => {
    const db = freshDb();
    const { a, b } = seedPayment(db);
    const accounts = new AccountRepo(db);
    expect(accounts.balanceOf(a)).toBe(300); // 500 funded - 200 paid
    expect(accounts.balanceOf(b)).toBe(200);

    const ledger = new LedgerRepo(db);
    const payEntries = ledger.entriesForAccount(a).filter((e) => e.direction === 'debit');
    expect(payEntries[0]!.balanceAfter).toBe(300);
    db.close();
  });

  it('ROLL BACK completely on overdraft (proof, not assumption)', async () => {
    const db = freshDb();
    const { a, b } = seedPayment(db, 500);
    const accounts = new AccountRepo(db);
    const txns = new TransactionRepo(db);
    const ledger = new LedgerRepo(db);

    let threw: unknown;
    try {
      db.withTransaction(() => {
        // A whole transaction row is created first — it must NOT survive the failure.
        const doomed = newId();
        txns.insert({ id: doomed, humanRef: 'PM-TEST-DOOM', type: 'payment', amountPiasters: 800, customerAccountId: a, merchantAccountId: b });
        ledger.post(doomed, [
          { accountId: a, direction: 'debit', amountPiasters: 800 }, // balance 300 -> -500 -> CHECK aborts
          { accountId: b, direction: 'credit', amountPiasters: 800 }
        ]);
        txns.updateStatus(doomed, 'completed');
      });
    } catch (err) {
      threw = err;
    }
    expect(threw, 'overdraft must throw').toBeDefined();
    expect(String(threw)).toMatch(/CHECK|balance/i);

    // Nothing moved: balances intact, zero rows from the aborted transaction.
    expect(accounts.balanceOf(a)).toBe(300);
    expect(accounts.balanceOf(b)).toBe(200);
    expect(txns.getByRef('PM-TEST-DOOM')).toBeNull();
    expect((db.stmt('SELECT COUNT(*) AS n FROM ledger_entries').get() as { n: number }).n).toBe(4); // only seedPayment's
    assertInvariants(db);
    db.close();
  });

  it('reject unbalanced postings before touching SQL', () => {
    const db = freshDb();
    const accounts = new AccountRepo(db);
    const a = accounts.createForOwner({ ownerType: 'customer', ownerId: 'c1' }).id;
    const ledger = new LedgerRepo(db);
    const txn = newId();
    new TransactionRepo(db).insert({ id: txn, humanRef: 'PM-X', type: 'payment', amountPiasters: 100, customerAccountId: a });
    expect(() =>
      ledger.post(txn, [
        { accountId: a, direction: 'debit', amountPiasters: 100 },
        { accountId: a, direction: 'credit', amountPiasters: 90 }
      ])
    ).toThrow(/unbalanced/);
    db.close();
  });

  it('enforce append-only ledger and audit tables at the SQL layer', async () => {
    const db = freshDb();
    seedPayment(db);
    await new AuditRepo(db).append({ actorType: 'system', actorId: 'test', event: 'test.event' });
    expect(() => db.exec("UPDATE ledger_entries SET amount_piasters = 1")).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM ledger_entries')).toThrow(/append-only/);
    expect(() => db.exec("UPDATE audit_log SET event = 'forged'")).toThrow(/append-only/);
    expect(() => db.exec('DELETE FROM audit_log')).toThrow(/append-only/);
    db.close();
  });

  it('freeze immutable transaction fields but allow status moves', () => {
    const db = freshDb();
    const { txn } = seedPayment(db);
    expect(() => db.exec('UPDATE transactions SET amount_piasters = 999')).toThrow(/immutable/);
    expect(() => db.exec("UPDATE transactions SET type = 'refund'")).toThrow(/immutable/);
    expect(() => db.exec("UPDATE transactions SET human_ref = 'PM-HACKED'")).toThrow(/immutable/);
    // Legal transitions still work:
    db.stmt('UPDATE transactions SET status = ? WHERE id = ?').run('reversed', txn);
    expect(() =>
      db
        .stmt('UPDATE transactions SET status = ? WHERE id = ?')
        .run('completed', txn)
    ).toThrow(/illegal transaction status transition/);
    db.close();
  });
});

describe('repos', () => {
  it('paginate account history with keyset cursors', () => {
    const db = freshDb();
    const accounts = new AccountRepo(db);
    const txns = new TransactionRepo(db);
    const ledger = new LedgerRepo(db);
    const a = accounts.createForOwner({ ownerType: 'customer', ownerId: 'c' }).id;
    const sys = accounts.ensureForOwner({ ownerType: 'system', ownerId: 'topup_source' }).id;
    // 25 deposits -> 25 history items for `a`.
    for (let i = 0; i < 25; i++) {
      const id = newId();
      txns.insert({ id, humanRef: `DP-H-${String(i).padStart(4, '0')}`, type: 'deposit', amountPiasters: 100, customerAccountId: a, requestId: null });
      ledger.post(id, [
        { accountId: sys, direction: 'debit', amountPiasters: 100 },
        { accountId: a, direction: 'credit', amountPiasters: 100 }
      ]);
      txns.updateStatus(id, 'completed');
    }
    const page1 = txns.listByAccount(a, { limit: 10 });
    expect(page1.items.length).toBe(10);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = txns.listByAccount(a, { limit: 10, cursor: page1.nextCursor });
    expect(page2.items.length).toBe(10);
    const page3 = txns.listByAccount(a, { limit: 10, cursor: page2.nextCursor });
    expect(page3.items.length).toBe(5);
    expect(page3.nextCursor).toBeNull();
    const refs = new Set([...page1.items, ...page2.items, ...page3.items].map((t) => t.humanRef));
    expect(refs.size).toBe(25); // no duplicates or gaps across pages
    db.close();
  });

  it('store one active template per subject and revoke cleanly', async () => {
    const db = freshDb();
    new CustomerRepo(db).insert({ id: 'c-1', phone: '+201000000001', name: 'Test', pinHash: 'scrypt$x' });
    const store = new SqliteTemplateStore(db);
    const sealed = { ciphertext: new Uint8Array(32).fill(9), keyId: 'k1' };
    await store.insert({
      templateId: 't1', subjectType: 'customer', subjectId: 'c-1',
      algoId: 'palma-sim-hog-v1', algoVersion: '1.0.0', descriptorDim: 160, bits: 1024,
      keyId: 'k1', sealed, qualityScore: 0.9, captureSource: 'synthetic'
    });
    // A second ACTIVE insert for the same subject violates the partial unique index.
    await expect(
      store.insert({
        templateId: 't2', subjectType: 'customer', subjectId: 'c-1',
        algoId: 'palma-sim-hog-v1', algoVersion: '1.0.0', descriptorDim: 160, bits: 1024,
        keyId: 'k1', sealed, qualityScore: 0.9, captureSource: 'synthetic'
      })
    ).rejects.toThrow(/UNIQUE/i);

    expect(await store.getById('t1')).not.toBeNull();
    expect((await store.getBySubject('customer', 'c-1')).length).toBe(1);
    expect((await store.revokeActive('customer', 'c-1'))).toBe(1);
    expect((await store.getBySubject('customer', 'c-1')).length).toBe(0);
    // Revoked row is retained for audit...
    const kept = await store.getById('t1');
    expect(kept).not.toBeNull();
    // ...and ciphertext survives as opaque bytes.
    expect(kept!.sealed.ciphertext[0]).toBe(9);
    db.close();
  });

  it('detect replay payload mismatches through the idempotency table', () => {
    const db = freshDb();
    const repo = new IdempotencyRepo(db);
    expect(repo.claim('payments.authorize', 'req-1', sha256Hex('{"a":1}'))).toBeNull(); // first sighting
    const row = repo.claim('payments.authorize', 'req-1', sha256Hex('{"a":1}')); // same payload again
    expect(row?.payloadHash).toBe(sha256Hex('{"a":1}'));
    // Same key, DIFFERENT payload: claim hands back the original row so the API
    // can see stored-hash != presented-hash and reject as REPLAY_MISMATCH.
    const presented = sha256Hex('{"a":2}');
    const mismatch = repo.claim('payments.authorize', 'req-1', presented);
    expect(mismatch).not.toBeNull();
    expect(mismatch!.payloadHash).not.toBe(presented);
    repo.saveResponse('payments.authorize', 'req-1', '{"ok":true}', 200);
    expect(repo.get('payments.authorize', 'req-1')?.responseJson).toBe('{"ok":true}');
    db.close();
  });
});

describe('audit hash chain', () => {
  it('verify a clean chain and localize tampering', async () => {
    const db = freshDb();
    const audit = new AuditRepo(db);
    await audit.append({ actorType: 'system', actorId: 'seed', event: 'seed.completed', data: { customers: 3 } });
    await audit.append({ actorType: 'customer', actorId: 'c-1', event: 'palm.enrolled', outcome: 'ok', data: {} });
    await audit.append({ actorType: 'merchant', actorId: 'm-1', event: 'payment.authorized', outcome: 'rejected', data: { reason: 'no_match' } });

    const clean = audit.verifyChain();
    expect(clean.ok).toBe(true);
    expect(clean.checked).toBe(3);

    // Tamper with row 2 (triggers dropped ONLY inside this test).
    db.exec('DROP TRIGGER audit_no_update;');
    db.exec("UPDATE audit_log SET data_json = '{\"forged\":true}' WHERE seq = 2;");
    const broken = audit.verifyChain();
    expect(broken.ok).toBe(false);
    expect(broken.brokenAtSeq).toBe(2);
    db.close();
  });

  it('never fork the chain under repeated appends', async () => {
    const db = freshDb();
    const audit = new AuditRepo(db);
    for (let i = 0; i < 30; i++) await audit.append({ actorType: 'system', actorId: 't', event: `e.${i}` });
    expect(audit.verifyChain().ok).toBe(true);
    const hashes = (db.stmt('SELECT COUNT(DISTINCT row_hash) AS n FROM audit_log').get() as { n: number }).n;
    expect(hashes).toBe(30);
    db.close();
  });
});

describe('invariants', () => {
  it('pass on healthy data', () => {
    const db = freshDb();
    seedPayment(db);
    const report = collectInvariants(db);
    expect(report.ok).toBe(true);
    expect(report.checks.length).toBeGreaterThanOrEqual(6);
    db.close();
  });

  it('catch a hand-corrupted balance (bypassing the ledger-trigger convention)', () => {
    const db = freshDb();
    seedPayment(db);
    // Balances are protected by CONVENTION (only triggers move them), unlike the
    // physically append-only ledger — so invariants must independently detect a
    // rogue UPDATE.
    db.exec('UPDATE wallet_accounts SET balance_piasters = balance_piasters + 7');
    expect(() => assertInvariants(db)).toThrow(/balances_match_ledger/);
    db.close();
  });
});

describe('cross-connection serialization', () => {
  it('serialize concurrent writers so read-modify-write cannot lose updates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'palma-db-test-'));
    const path = join(dir, 'conc.db');
    try {
      const setup = new PalmaDatabase(path);
      runMigrations(setup);
      const acc = new AccountRepo(setup);
      const target = acc.createForOwner({ ownerType: 'system', ownerId: 'counter' }).id;
      setup.close();

      // Two processes-equivalent connections each bump the SAME account 20 times,
      // reading then writing inside BEGIN IMMEDIATE. Lost updates would show up
      // as a final balance below 40.
      const bump = async (): Promise<void> => {
        const db = new PalmaDatabase(path, { busyTimeoutMs: 4000 });
        try {
          for (let i = 0; i < 20; i++) {
            await db.withTransaction(() => {
              const cur = (db.stmt('SELECT balance_piasters AS b FROM wallet_accounts WHERE id = ?').get(target) as { b: number }).b;
              db.stmt('UPDATE wallet_accounts SET balance_piasters = ?, updated_at = ? WHERE id = ?').run(cur + 1, nowIso(), target);
            });
          }
        } finally {
          db.close();
        }
      };
      await Promise.all([bump(), bump()]);
      const check = new PalmaDatabase(path);
      try {
        expect(new AccountRepo(check).balanceOf(target)).toBe(40);
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('foreign keys + misc', () => {
  it('cascade nothing silently: dangling references are rejected', () => {
    const db = freshDb();
    const txns = new TransactionRepo(db);
    expect(() =>
      txns.insert({ id: newId(), humanRef: 'DP-BAD', type: 'deposit', amountPiasters: 100, customerAccountId: 'missing-account' })
    ).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it('generate unique human refs and ids', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = randomUUID();
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});
