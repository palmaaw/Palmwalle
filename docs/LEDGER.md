# The wallet ledger — SIMULATED, but honestly accounted

> ⚠️ **No real financial rails.** This ledger is a local SQLite database that
> behaves the way a payment core *should* behave: every movement balances,
> balances are re-derivable from movements, records are append-only, and money
> never moves twice by accident. It exists to prototype the product experience
> and to make the future InstaPay / Vodafone Cash integration a drop-in.

## Money

All amounts are **integer piasters** (1 EGP = 100 piasters). Floats never touch
money. `formatEGP()` is the only display formatter; `toPiasters()` the only parser.

## Double-entry model

Every transaction posts ≥2 legs into `ledger_entries`:

```
deposit  : debit  system/topup_source   credit customer wallet
payment  : debit  customer wallet       credit merchant wallet
refund   : debit  merchant wallet       credit customer wallet   (links parent)
```

The sum of all debits equals the sum of all credits — always. Wallet balances
are not edited directly; they move **only** via `AFTER INSERT` triggers on
`ledger_entries`. An overdraft therefore aborts at the SQL `CHECK` layer even if
application code were wrong: the entire transaction (txn row + legs + status +
audit) rolls back. This is proven, not assumed — see the overdraft-rollback test
in `packages/db/src/db.test.ts`.

The system float account (`topup_source`) may go negative by design; it represents
the seeder's demo money. The invariant checker excludes it when asserting no
negative balances.

## SQL-level guarantees (triggers in migration 0002)

| Guarantee | Mechanism |
|---|---|
| Ledger is append-only | `UPDATE`/`DELETE` on `ledger_entries`, `audit_log` → `RAISE(ABORT)` |
| Txn cores immutable | id/type/ref/amount/parent frozen after insert |
| Status machine | only `pending → completed | failed`; `completed → reversed` |
| One active palm per customer | partial UNIQUE index |
| Balanced postings | app asserts debits == credits per txn inside the write lock |

## Idempotency & replay protection

Every money-moving request carries `(requestId uuid, timestamp)`:

1. **Freshness** — client timestamp must be within ±5 min of server time,
   checked before anything else. Stale ⇒ `REQUEST_STALE`.
2. **Payload binding** — first sighting of a requestId claims
   `(scope, key) → hash(payload)`. The same requestId with *different semantic
   content* (amount/source/probe) ⇒ `409 REQUEST_REPLAY_PAYLOAD_MISMATCH`.
3. **Response replay** — same requestId + same content returns the ORIGINAL
   response verbatim with `replayed: true`. Never re-settles.
4. **Concurrency collapse** — an in-process in-flight map merges duplicate
   concurrent submissions onto one execution; the DB row covers restarts.
5. **Provider failures leave no movement** — simulated top-ups call the provider
   BEFORE any posting; failure records an audit-only failed transaction.

Semantic payload hashes exclude the volatile timestamp envelope, so both a
byte-identical retry and a regenerated-timestamp retry of the same intent replay
safely — anything else conflicts.

## Invariant checker (`packages/db/src/invariants.ts`)

Six independent re-derivations, exposed via `GET /api/v1/dev/invariants` and
`npm run audit:verify`:

ledger_balanced · postings_balanced · balances_match_ledger (re-derived from
legs) · no_negative_balances (excl. system) · txn_entry_counts ·
one_active_template_per_subject.

## Audit log

Append-only hash chain:
`row_hash = sha256(prev_hash ‖ ts ‖ actor ‖ event ‖ subject ‖ outcome ‖ data)`
computed inside the same write lock as the movement, so two writers can never
fork the chain. `verifyChain()` walks the whole history and localizes any tamper
to a seq. What belongs there: outcomes, scores, references. What NEVER belongs:
descriptors, template ciphertext, images, PINs.

## The real-rails seam

```ts
interface PaymentProviderAdapter {          // apps/api/src/providers/
  readonly id: 'instapay_sim' | 'vodafone_cash_sim';
  initiateTopUp(r: TopUpRequest): Promise<TopUpResult>;
}
```

Licensed integrations implement this interface (plus a payout/transfer adapter
for settlements); the ledger service boundary stays identical. Simulated adapters
are deterministic — a nil-prefixed uuid requestId simulates a provider outage so
failure paths are demoable and testable.

## Known simplifications (documented, deliberate)

- Single-writer SQLite: no multi-instance deployment story yet.
- Refunds are full-and-once; no partial refunds.
- No interest, fees, holds, or settlement windows.
- "Today's takings" is computed client-side from history.
