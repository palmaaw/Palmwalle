/**
 * Standalone integrity report for a Palm Wallet database: re-derives ledger
 * balances, checks the double-entry invariants, and walks the audit hash
 * chain. Run against the live path after any suspicious activity — or before
 * a demo, to prove the books still balance.
 *
 * Usage: npm run audit:verify   (DATABASE_PATH env or ./data/palm-wallet.db)
 */

import { AuditRepo, PalmWalletDatabase, collectInvariants } from '@palmwallet/db';

function egp(piasters: number): string {
  return `EGP ${(piasters / 100).toLocaleString('en-EG', { minimumFractionDigits: 2 })}`;
}

async function main(): Promise<void> {
  const path = process.env.DATABASE_PATH ?? './data/palm-wallet.db';
  if (path === ':memory:') {
    console.error('refusing to verify :memory: — set DATABASE_PATH to a real file');
    process.exit(1);
  }

  let db: PalmWalletDatabase;
  try {
    db = new PalmWalletDatabase(path);
  } catch (err) {
    console.error(`cannot open ${path}:`, err instanceof Error ? err.message : err);
    process.exit(1);
  }

  console.log(`Palm Wallet integrity report — ${path}\n`);
  let failures = 0;

  const report = collectInvariants(db);
  for (const check of report.checks) {
    if (!check.ok) failures++;
    console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
  }

  const chain = new AuditRepo(db).verifyChain();
  if (!chain.ok) failures++;
  console.log(
    `  ${chain.ok ? 'PASS' : 'FAIL'}  audit_hash_chain — ${chain.checked} events` +
      (chain.ok ? '' : `, BROKEN at seq ${chain.brokenAtSeq}: ${chain.reason}`)
  );

  // Small human-friendly tail so operators see *what* was audited recently.
  const tail = new AuditRepo(db).list(5).reverse();
  if (tail.length > 0) {
    console.log('\nRecent audit events:');
    for (const r of tail) {
      console.log(`  [${r.ts}] ${r.actorType}:${r.actorId.slice(0, 8)} ${r.event} → ${r.outcome}`);
    }
  }

  const counts = db.stmt(
    "SELECT (SELECT COUNT(*) FROM transactions) AS txns, (SELECT COUNT(*) FROM transactions WHERE status='completed') AS settled, (SELECT COALESCE(SUM(amount_piasters),0) FROM transactions WHERE type='payment' AND status='completed') AS gmv"
  ).get() as { txns: number; settled: number; gmv: number };
  console.log(`\nTransactions: ${Number(counts.txns)} total, ${Number(counts.settled)} completed, simulated GMV ${egp(Number(counts.gmv))}`);
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`} ⚠️ SIMULATED prototype — no real financial rails`);
  db.close();
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('audit verify crashed:', err instanceof Error ? err.stack : err);
  process.exit(1);
});
