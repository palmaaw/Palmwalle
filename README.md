# PalmPay — pay with a wave 🖐️

A **palm-biometric payment prototype for Egypt**: enroll your palm from your phone,
then pay at a merchant counter by holding your palm over the reader — no card, no
cash, no phone at the till.

> ## ⚠️ This is a SIMULATED PROTOTYPE
>
> - **No real financial rails.** Balances live in a local SQLite double-entry
>   ledger. InstaPay / Vodafone Cash appear only as *simulated provider adapters*
>   that are designed to be swapped for licensed integrations later.
> - **Biometric matching is SIMULATED** — a research-grade pipeline behind a
>   swappable interface, not a certified SDK. See [docs/BIOMETRICS.md](docs/BIOMETRICS.md).
> - **The palm never leaves your device in any usable form.** Frames are
>   extracted AND turned into a one-way 1024-bit code **on your device** (phone or
>   POS reader) — only that ~172-byte code is ever transmitted; raw frames and
>   feature vectors never touch the network. The server seals codes with AES-256-GCM
>   under a key separate from the device-visible protection key. Unlike a password,
>   though, *a biometric cannot be rotated if compromised* — which is exactly why
>   this must remain a prototype until real certified hardware+software replaces it.
> - Not a production financial or biometric system. Do not use real personal data.

---

## What's inside

| Piece | Where | What it does |
|---|---|---|
| `@palma/shared` | `packages/shared` | Money as integer piasters, zod wire schemas (single source of truth), error codes, thresholds |
| `@palma/biometrics` | `packages/biometrics` | SIMULATED palm pipeline: synthetic capture → quality → HOG descriptors → **on-device one-way 1024-bit codes** → sealed storage + Hamming matching. Runs identically in browser & Node |
| `@palma/db` | `packages/db` | SQLite persistence: checksummed migrations, SQL-enforced ledger invariants, hash-chained audit log |
| `@palma/api` | `apps/api` | Fastify API: auth, enrollment, wallets, one-step scan-&-pay, refunds, replay protection |
| `@palma/customer` | `apps/customer` | Customer PWA (`:5173`): register → enroll palm by camera (or demo palms) → wallet → history → receipts |
| `@palma/merchant` | `apps/merchant` | POS PWA (`:5174`): amount keypad → scan customer palm → instant settle → refunds |
| `@palma/cli` | `apps/cli` | Seeder, smoke test, headless E2E over real HTTP, audit verifier |

## Quick start

```bash
npm install

npm run seed        # create ./data/palma.db with demo identities (idempotent)
npm run dev         # run all three: api :8787 · customer :5173 · pos :5174
```

Open the forwarded URLs:

1. **Customer app** — sign in as a seeded customer (below). Your demo palm is
   already enrolled. Top up the wallet via the simulated InstaPay/Vodafone Cash
   sheet.
2. **POS app** — sign in as the demo shop. Enter an amount, pick who's paying on
   the SIMULATED reader (or "Stranger" to watch it get rejected), and the payment
   settles atomically.

### Demo credentials

| Role | Login | PIN | Wallet |
|---|---|---|---|
| Customer | `+201000000001` (Aya) | `1234` | EGP 2,500 |
| Customer | `+201000000002` (Omar) | `1234` | EGP 800 |
| Customer | `+201000000003` (Nour) | `1234` | EGP 0 — insufficient-funds demo |
| Merchant POS | `ZAMALEK-COFFEE` | `2468` | EGP 5,000 |

Registering more merchants (dev only) needs the setup token `palma-dev-setup`
(override with `DEV_SETUP_TOKEN`). Dev diagnostics endpoints need
`x-dev-token: palma-dev`.

## Prove it works without a browser

```bash
npm test            # 78 unit/integration tests (biometrics calibration, key separation, DB guarantees, full API matrix)
npm run smoke       # boots the real API and walks one payment
npm run e2e         # 22-step headless checklist over real HTTP incl. replay matrix + privacy greps
npm run audit:verify # re-derive balances + walk the audit hash chain
```

The E2E prints a PASS/FAIL checklist and exits nonzero on any failure:
register → fetch protection key (anon fetch must be rejected) → enroll →
top-up (+replay/mutate/stale/provider-fail) → merchant bootstrap → correct-palm
pay → unknown-palm reject → authorize replay/mutate → insufficient funds →
refund (+repeat refused) → both histories → invariants → audit chain → privacy
grep over every response body.

## Configuration

Copy `.env.example` to `.env`. In development with `DEMO_MODE=true` the server
generates and persists throwaway secrets to `data/.dev-secrets.json` so restarts
are stable. **Never use those values anywhere real** — set `JWT_SECRET` and
`TEMPLATE_MASTER_KEY` explicitly instead. Production mode refuses to boot without
them.

The root `dev`/`dev:api` scripts pin `DATABASE_PATH` to `<repo>/data/palma.db`
(absolute) because npm runs workspace scripts with the workspace as cwd — this
keeps seed, dev, and `audit:verify` on one database file no matter how you launch
them.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — components, boundaries, data flow
- [docs/BIOMETRICS.md](docs/BIOMETRICS.md) — how the (simulated) palm pipeline works, what's stored, honest limits
- [docs/LEDGER.md](docs/LEDGER.md) — double-entry design, SQL guarantees, idempotency/replay rules
- [docs/API.md](docs/API.md) — every endpoint with examples

## Before this could ever be production

1. Replace `@palma/biometrics` with a **certified palm SDK** (hardware reader or
   certified phone-vendor stack) behind the same `BiometricService` interface.
2. Replace the sim adapters in `apps/api/src/providers/` with licensed
   InstaPay / Vodafone Cash integrations under PSP agreements.
3. Move to a hardened multi-writer datastore; SQLite here proves the accounting
   model but is single-node.
4. Add refresh-token sessions, device binding, rate limiting at the edge,
   protection keys held in reader secure hardware (not served to JS), KMS-held
   storage keys with rotation, and independent security review of the biometric
   storage scheme.
