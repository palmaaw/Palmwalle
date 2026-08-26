# API reference (v1)

Base URL: `http://localhost:8787` (dev PWAs reach it same-origin via the Vite proxy).

All bodies are JSON with the envelope:

```jsonc
// success                                   // failure
{ "ok": true, "data": { ... } }              { "ok": false, "error": { "code": "...", "message": "..." } }
```

Biometric rejections from `/payments/authorize` are **HTTP 200** with
`data.status = 'rejected'` — they are outcomes, not errors.

## Error codes → HTTP

| Code | HTTP | When |
|---|---|---|
| VALIDATION_ERROR | 400 | schema violation / stale / malformed |
| REQUEST_STALE | 400 | timestamp outside ±5 min freshness window |
| AUTH_REQUIRED / AUTH_INVALID_CREDENTIALS | 401 | missing/failed auth |
| ACCOUNT_DISABLED · FORBIDDEN · NOT_FOUND | 403/403/404 | state/ownership |
| REQUEST_REPLAY_PAYLOAD_MISMATCH | 409 | reused requestId, different content |
| INSUFFICIENT_FUNDS · REFUND_NOT_ALLOWED | 422 | money rules |
| BIOMETRIC_LOW_QUALITY / UNSUPPORTED_ALGO | 422 | unusable capture / malformed palm code |
| RATE_LIMITED | 429 | login throttling · scan-&-pay and self-test probe budgets |
| PROVIDER_FAILED | 502 | simulated provider outage |

Auth: `Authorization: Bearer <accessToken>`. Dev diagnostics:
`x-dev-token: palma-dev`. Merchant bootstrap: `x-setup-token: palma-dev-setup`.

---

## Health & meta

| Endpoint | Description |
|---|---|
| `GET /healthz` | liveness |
| `GET /readyz` | `{status:'ready', ledgerBalanced:true}` |
| `GET /api/v1/meta` | algo id/version/threshold + limits + `simulated:true`, `prototype:true` |

## Customers

```http
POST /api/v1/customers/register     { name, phone:"+2010…", pin:"1234" }
→ { accessToken, tokenType:"Bearer", expiresInSeconds, customer }

POST /api/v1/auth/customer/login    { phone, pin }        # throttled
GET  /api/v1/customers/me
POST /api/v1/customers/me/pin       { currentPin, newPin }
```

## Palm lifecycle

The palm never reaches the server as pixels or features. The **device** extracts
frames and projects them into a one-way 1024-bit code; every biometric endpoint
accepts only that code:

```jsonc
// the ONLY palm-derived artifact on the wire (~172 B base64)
{ "code": { "algoId": "palma.palm.hog-sign.v1", "version": 1,
             "bits": "<base64 of exactly 128 bytes>" } }
```

```http
GET  /api/v1/biometrics/protection-key   # any active session (customer or merchant)
→     { algoId, version:1, protectionKeyB64 }
#   Device-side subkey used to build codes. Held in device memory only.
#   Prototype-grade custody (see BIOMETRICS.md); requires auth so anonymous
#   callers can't mint well-formed probes.

POST   /api/v1/customers/me/palm/enroll
       { code:{algoId,version,bits}, quality:{score,usable,…},
         consistencyScore,                       # device-attested frame stability ≥ 0.5
         capture:{source:'camera'|'synthetic', frames} }
→      { enrolled:true, templateId, consistencyScore }      # supersedes old

GET    /api/v1/customers/me/palm/status  → { enrolled, templateId, algo }
POST   /api/v1/customers/me/palm/self-test  { probe:{code,quality} }
       → { decision:'match'|'no_match', score, threshold }  # live 1:1, own template;
                                                            # rate-limited per customer
DELETE /api/v1/customers/me/palm            { pin }          # PIN re-auth required
```

## Wallet

```http
GET  /api/v1/customers/me/wallet          → { wallet:{ balancePiasters, formatted, … } }

POST /api/v1/customers/me/deposits        # SIMULATED top-up
     { requestId:uuid, timestamp:ISO, amountPiasters, source:'instapay_sim'|'vodafone_cash_sim' }
→    { status:'completed', transaction, wallet }   (replays carry replayed:true)
# requestId starting 00000000- simulates a provider outage → 502 PROVIDER_FAILED

GET  /api/v1/customers/me/transactions?cursor&limit=20
→    { items:[TransactionDTO…], nextCursor }   # signedAmountPiasters: +in −out
```

## Merchants

```http
POST /api/v1/merchants/register           # header x-setup-token required (dev bootstrap)
     { name, code:"ZAMALEK-COFFEE", phone, pin }
POST /api/v1/auth/merchant/login          { identifier: code-or-phone, pin }
GET  /api/v1/merchants/me · /me/wallet · /me/transactions?cursor&limit
```

## Payments — one-step scan & pay

The POS protects the scan locally into a code before it ever calls this endpoint.

```http
POST /api/v1/payments/authorize
     { requestId:uuid, timestamp:ISO, amountPiasters, probe:{code:{algoId,version,bits}, quality} }
```

Per-merchant rate limit applies **before** matching (default 30/min) — exceeding
it is `429 RATE_LIMITED`. Matching-palm responses carry a coarse similarity
**band**, never a precise score (anti score-oracle; exact scores exist only in
settlement records and the audit chain):

```jsonc
{ "ok": true, "data": {
    "status": "completed",
    "transaction": { "ref":"PM-2026…", "type":"payment", "status":"completed",
                      "amountPiasters":12000, "createdAt":"…", "settledAt":"…" },
    "customer":   { "displayName":"Aya Hassan", "maskedPhone":"+2010•••001" },
    "match":      { "outcome":"match", "similarityBand":"high",
                     "threshold":0.86, "algoId":"palma.palm.hog-sign.v1" },
    "wallet":     { "balancePiasters":238000, "formatted":"EGP 2,380.00" } } }
```

`similarityBand`: `"high"` (≥ threshold) · `"grey"` (0.76–0.86, rejected as
low-confidence) · `"low"`.

Unknown palm (HTTP 200, no movement):

```jsonc
{ "ok": true, "data": { "status":"rejected", "code":"BIOMETRIC_NO_MATCH",
                          "message":"No enrolled customer matches this palm",
                          "match":{ "outcome":"no_match", "similarityBand":"low", … } } }
```

Insufficient funds ⇒ `422 INSUFFICIENT_FUNDS`. Replay of identical request ⇒
original response with `replayed:true`; mutated payload on a used requestId ⇒
`409 REQUEST_REPLAY_PAYLOAD_MISMATCH`.

## Refunds (merchant owns the payment; full and once-only)

```http
POST /api/v1/transactions/:ref/refund   { requestId:uuid, timestamp:ISO, reason? }
→    { status:'refunded', refund:TransactionDTO, customerWalletAfter }
# second refund → 422 REFUND_NOT_ALLOWED · another merchant's sale → 403 FORBIDDEN
```

## Dev diagnostics (guarded)

```http
GET /api/v1/dev/invariants     # 6 ledger/template checks → { ok, checks[] }
GET /api/v1/dev/audit/verify   # hash-chain walk → { ok, checked, brokenAtSeq }
GET /api/v1/dev/audit/tail     # last N audit events
```

## TransactionDTO shape

```jsonc
{ "id":"…", "ref":"PM-20260826-XEXWDN", "type":"deposit|payment|refund",
  "status":"pending|completed|failed|reversed",
  "amountPiasters":150000, "signedAmountPiasters":150000,
  "formatted":"EGP 1,500.00",
  "counterparty":{ "displayName":"Zamalek Coffee", "maskedPhone":"+2012•••001" } | null,
  "parentRef":"PM-…" | null,          // refunds link their payment
  "provider":"instapay_sim" | null, "failureCode":null,
  "createdAt":"…", "settledAt":"…|null" }
```
