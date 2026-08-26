# Architecture

```
┌────────────────────────────┐        ┌────────────────────────────┐
│  Customer PWA  :5173       │        │  Merchant POS  :5174       │
│  React + Vite (PWA)        │        │  React + Vite (PWA)        │
│                            │        │                            │
│  register / login          │        │  login / dev bootstrap     │
│  palm capture (camera OR   │        │  amount keypad             │
│    synthetic demo palms)   │        │  scan → authorize → result │
│  quality+stability gating  │        │  refunds, history          │
│  ON-DEVICE protection:     │        │  ON-DEVICE protection:     │
│   fuse + project → 1024-bit│        │   fuse + project → 1024-bit│
│   one-way code             │        │   one-way code             │
│  wallet · history · PIN    │        │                            │
└─────────────┬──────────────┘        └─────────────┬──────────────┘
              │  protected code only (128 B)        │  protected code only
              │  NEVER images, NEVER descriptors    │  (128 B)
              ▼                                     ▼
        ┌─────────────────────────────────────────────────┐
        │            @palma/api  — Fastify :8787          │
        │                                                 │
        │  zod schemas (@palma/shared) = wire contract    │
        │  auth: HS256 JWT + scrypt PINs + login throttle │
        │  replay guard: freshness → payload binding →    │
        │                response replay (+inflight dedup)│
        │  probe throttle per merchant (score-oracle      │
        │  mitigation); payment responses carry score     │
        │  BANDS, never raw similarity                    │
        │                                                 │
        │  PaymentService.authorize:                      │
        │    biometric match (ASYNC, outside tx)          │
        │      ↓                                          │
        │    settlement (ONE synchronous SQLite tx)       │
        │                                                 │
        │  LedgerService (double-entry)                   │
        │  ProviderRegistry: instapay_sim · vfcash_sim ⚠️ │
        │  redacting logger · audit hash chain            │
        └───────────────┬──────────────────┬──────────────┘
                        ▼                  ▼
             ┌──────────────────┐  ┌───────────────────────────┐
             │  @palma/db       │  │  @palma/biometrics  ⚠️    │
             │  node:sqlite WAL │  │  SIMULATED pipeline:      │
             │  checksummed     │  │  device-side protect →    │
             │  migrations      │  │  seal(GCM) → Hamming      │
             │  SQL invariants  │  │  match; HKDF split keys   │
             │  audit chain     │  │  (device vs storage);     │
             └──────────────────┘  │  swappable seam for a     │
                                   │  certified SDK            │
                                   └───────────────────────────┘
```

⚠️ = simulated component. See [BIOMETRICS.md](BIOMETRICS.md) and [LEDGER.md](LEDGER.md).

## Monorepo layout

npm workspaces, TypeScript strict, vitest. `packages/*` are libraries;
`apps/*` are deployables. Dependencies point at workspace **source** (no build
step between packages) via `exports: "./src/index.ts"` + tsx/vite.

## The boundaries that matter

1. **Biometric layer vs payment layer.** Everything about palms lives behind the
   `BiometricService` interface (`@palma/biometrics` + `SqliteTemplateStore`).
   The interface accepts only ALREADY-PROTECTED codes — the server has no code
   path that turns vectors into templates, so descriptors cannot be smuggled in.
2. **Device-side protection.** Frames are extracted AND projected into a one-way
   1024-bit code on the capturing device (customer phone / POS reader); only that
   code travels. The protection subkey is fetched authenticated and held in
   memory; the at-rest sealing key never leaves the server. This is both a
   privacy property and the reason browser and Node run byte-identical pipeline
   code.
3. **Async match OUTSIDE the transaction.** `PaymentService.authorize` runs the
   1:N match before opening the write lock; settlement then happens in one
   synchronous SQLite transaction (`BEGIN IMMEDIATE`). No await ever sits inside
   a transaction — enforced by `withTransaction()` rejecting Promise-returning
   callbacks (this was a real bug class during development).
4. **Wire truth in one place.** Every request/response shape is a zod schema in
   `@palma/shared`, imported verbatim by the API and both PWAs.
5. **Simulated rails behind adapters.** InstaPay/Vodafone Cash are registry
   entries; licensed integrations replace them without touching services.

## Money flow (scan & pay)

```
POS protects scan locally (fuse+project) ──► POST /payments/authorize
  {requestId, timestamp, amountPiasters, probe:{code,quality}}
API: probe throttle → freshness check → decode code → idempotency claim
API: identifyPalm() 1:N over active templates        ← async, no lock held
   ├─ no_match/ambiguous → HTTP 200 {status:'rejected', code, match}
   │                         (ZERO ledger movement)
API: customer + wallet state checks                  ← still outside tx
API: withTransaction {                                ← BEGIN IMMEDIATE
       txn row (pending) → 2 legs → triggers move balances
       → status completed → audit append }           ← COMMIT or all-or-nothing
→ HTTP 200 {status:'completed', transaction, customer(masked), match, wallet}
```

Biometric rejections are deliberately **200 responses**, not errors: from the
POS's perspective "not recognized" is a normal outcome to show and retry.

## Storage

Single SQLite file (`DATABASE_PATH`, default `./data/palma.db`), WAL mode,
foreign keys on, busy_timeout 5 s. Migrations are checksummed; drift refuses to
boot. Tables: customers, merchants, wallet_accounts, biometric_templates,
transactions, ledger_entries, idempotency_records, audit_log (+ `_migrations`).

## Security posture (prototype-honest)

- PINs: scrypt (N=16384,r=8,p=1) + timing-safe compare; login throttling per
  identifier+IP.
- Biometrics: device-side one-way templating (see BIOMETRICS.md) — HKDF-split
  protection (device-visible) vs storage (server-only) subkeys; templates sealed
  AES-256-GCM at rest; per-merchant/customer probe throttling; payment responses
  expose similarity bands, not scores.
- Sessions: HS256 JWT, short TTL, typ-tagged (customer/merchant). No refresh
  tokens yet — documented gap.
- Secrets: env-only in production (fail-fast); DEMO_MODE persists generated dev
  secrets to `data/.dev-secrets.json` for restart stability.
- Logging: recursive redaction of pin/secret/token/descriptor/vec/ciphertext keys.
- Palm delete requires PIN re-auth. Re-enrollment supersedes atomically.
- Merchant registration is guarded by `x-setup-token` (dev bootstrap only).

## Testing strategy

- **Unit** (packages): money/canonical-JSON; extractor determinism; population
  separation (max impostor similarity < grey floor); robustness under jitter/
  noise/exposure; GCM tamper/wrong-key rejection; hamming math.
- **DB**: migration idempotency/drift; overdraft ROLLBACK proof; append-only +
  immutability triggers; keyset pagination; cross-connection write serialization;
  invariant checker against corrupted state.
- **API integration** (fastify.inject): auth/validation/lockout; enrollment
  supersede; full replay matrix; wrong-palm ⇒ rejected + zero movement;
  concurrent duplicate ⇒ exactly one settlement; owner-scoped once-only refunds;
  privacy greps over response bodies; dev diagnostics guards.
- **Headless E2E** (`npm run e2e`): real server, real HTTP, 22-step checklist,
  nonzero exit on failure.
