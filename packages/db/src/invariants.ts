/**
 * Whole-database integrity assertions — run by tests, the seeder, and the
 * GET /dev/invariants endpoint. Every rule here is enforced structurally by
 * schema/triggers too; these queries independently RE-DERIVE the facts so a bug
 * in our own code cannot silently satisfy itself.
 */

import { PalmaDatabase } from './database.js';

export interface InvariantCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface InvariantReport {
  ok: boolean;
  checks: InvariantCheck[];
}

export function collectInvariants(db: PalmaDatabase): InvariantReport {
  const checks: InvariantCheck[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  // 1. The book sums: total debits == total credits across the whole ledger.
  const totals = db
    .stmt(
      `SELECT
         COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_piasters END), 0) AS debits,
         COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_piasters END), 0) AS credits
       FROM ledger_entries`
    )
    .get() as { debits: number; credits: number };
  add('ledger_balanced', Number(totals.debits) === Number(totals.credits), `debits=${totals.debits} credits=${totals.credits}`);

  // 2. Every individual posting balances.
  const unbalanced = db
    .stmt(
      `SELECT transaction_id,
              SUM(CASE WHEN direction = 'debit' THEN amount_piasters ELSE -amount_piasters END) AS net
       FROM ledger_entries GROUP BY transaction_id HAVING net != 0 LIMIT 5`
    )
    .all() as Array<{ transaction_id: string; net: number }>;
  add('postings_balanced', unbalanced.length === 0, unbalanced.map((r) => `${r.transaction_id}:net=${r.net}`).join(', ') || 'all postings net to zero');

  // 3. Materialized balance == re-derived balance from the entries, per account.
  const drift = db
    .stmt(
      `SELECT w.id, w.balance_piasters AS stored,
              COALESCE(SUM(CASE WHEN l.direction = 'credit' THEN l.amount_piasters ELSE -l.amount_piasters END), 0) AS derived
       FROM wallet_accounts w
       LEFT JOIN ledger_entries l ON l.account_id = w.id
       GROUP BY w.id
       HAVING stored != derived LIMIT 5`
    )
    .all() as Array<{ id: string; stored: number; derived: number }>;
  add(
    'balances_match_ledger',
    drift.length === 0,
    drift.map((r) => `${r.id}:stored=${r.stored},derived=${r.derived}`).join(', ') || 'every balance re-derives from its entries'
  );

  // 4. No negative USER balances (system float may run negative by design;
  //    belt-and-braces over the CHECK constraint).
  const negative = db
    .stmt("SELECT id, balance_piasters AS b FROM wallet_accounts WHERE balance_piasters < 0 AND owner_type != 'system'")
    .all() as Array<{ id: string; b: number }>;
  add('no_negative_balances', negative.length === 0, negative.map((r) => `${r.id}:${r.b}`).join(', ') || 'none');

  // 5. Entry counts by status: unsettled/failed transactions carry NO legs;
  //    completed ones carry at least the debit+credit pair.
  const badCounts = db
    .stmt(
      `SELECT t.id, t.status, COUNT(l.seq) AS legs
       FROM transactions t LEFT JOIN ledger_entries l ON l.transaction_id = t.id
       GROUP BY t.id
       HAVING (t.status IN ('pending', 'failed') AND legs != 0)
           OR (t.status IN ('completed', 'reversed') AND legs < 2)
       LIMIT 5`
    )
    .all() as Array<{ id: string; status: string; legs: number }>;
  add(
    'txn_entry_counts',
    badCounts.length === 0,
    badCounts.map((r) => `${r.id}(${r.status})legs=${r.legs}`).join(', ') || 'entry counts consistent with statuses'
  );

  // 6. At most one active biometric template per subject (the partial UNIQUE
  //    index enforces this; verify the data satisfies it).
  const multiActive = db
    .stmt(
      `SELECT subject_id, COUNT(*) AS n FROM biometric_templates
       WHERE status = 'active' GROUP BY subject_id HAVING n > 1 LIMIT 5`
    )
    .all() as Array<{ subject_id: string; n: number }>;
  add('one_active_template_per_subject', multiActive.length === 0, multiActive.map((r) => `${r.subject_id}:n=${r.n}`).join(', ') || 'none');

  return { ok: checks.every((c) => c.ok), checks };
}

/** Hard-fail variant used by tests and the seeder. */
export function assertInvariants(db: PalmaDatabase): InvariantReport {
  const report = collectInvariants(db);
  if (!report.ok) {
    const failed = report.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`);
    throw new Error(`database invariants violated: ${failed.join('; ')}`);
  }
  return report;
}
