-- PalmPay PROTOTYPE schema — simulated wallet ledger + biometric template storage.
-- Money is integer piasters (1 EGP = 100). Timestamps are UTC ISO-8601 strings.
-- This is NOT a production financial database; see docs/LEDGER.md.

CREATE TABLE customers (
  id          TEXT PRIMARY KEY,
  phone       TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  pin_hash    TEXT NOT NULL,            -- scrypt, format: scrypt$N$r$p$salt$hash
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE merchants (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,     -- human business code, e.g. ZAMALEK-COFFEE
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL UNIQUE,
  pin_hash    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- Double-entry wallets. Balances move ONLY via ledger_entries AFTER INSERT
-- triggers (see 0002) — never by direct UPDATE from application code.
-- SYSTEM float accounts (e.g. topup_source) may go negative: they are not user
-- money, they track simulated provider outflow. Customer/merchant wallets cannot.
CREATE TABLE wallet_accounts (
  id               TEXT PRIMARY KEY,
  owner_type       TEXT NOT NULL CHECK (owner_type IN ('customer', 'merchant', 'system')),
  owner_id         TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'primary',
  currency         TEXT NOT NULL DEFAULT 'EGP',
  balance_piasters INTEGER NOT NULL DEFAULT 0
                   CHECK (balance_piasters >= 0 OR owner_type = 'system'),
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (owner_type, owner_id, kind)
);

-- Biometric templates. The ciphertext column is AES-256-GCM(nonce||ct||tag) of the
-- protected (projected+binarized) template — NEVER a raw palm image and NEVER a
-- plaintext descriptor. Revoked rows are retained for audit; a partial unique
-- index enforces at most ONE active template per subject.
CREATE TABLE biometric_templates (
  id             TEXT PRIMARY KEY,
  subject_type   TEXT NOT NULL CHECK (subject_type IN ('customer')),
  subject_id     TEXT NOT NULL REFERENCES customers(id),
  algo_id        TEXT NOT NULL,
  algo_version   TEXT NOT NULL,
  descriptor_dim INTEGER NOT NULL,
  bits           INTEGER NOT NULL,
  key_id         TEXT NOT NULL,
  ciphertext     BLOB NOT NULL,
  quality_score  REAL NOT NULL,
  capture_source TEXT NOT NULL CHECK (capture_source IN ('camera', 'synthetic')),
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  enrolled_at    TEXT NOT NULL,
  revoked_at     TEXT
);

CREATE TABLE transactions (
  id                   TEXT PRIMARY KEY,
  human_ref            TEXT NOT NULL UNIQUE,   -- PM-/DP-/RF- receipt reference
  type                 TEXT NOT NULL CHECK (type IN ('deposit', 'payment', 'refund')),
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'completed', 'failed', 'reversed')),
  amount_piasters      INTEGER NOT NULL CHECK (amount_piasters > 0),
  currency             TEXT NOT NULL DEFAULT 'EGP',
  customer_account_id  TEXT REFERENCES wallet_accounts(id),
  merchant_account_id  TEXT REFERENCES wallet_accounts(id),
  parent_transaction_id TEXT REFERENCES transactions(id),  -- refunds link their payment
  provider             TEXT,                    -- instapay_sim | vodafone_cash_sim | NULL
  provider_ref         TEXT,
  request_id           TEXT,                    -- client idempotency key (unique when present)
  meta_json            TEXT NOT NULL DEFAULT '{}',
  failure_code         TEXT,
  created_at           TEXT NOT NULL,
  settled_at           TEXT
);

-- Append-only double-entry ledger. balance_after is the posting account's
-- balance immediately after this entry's trigger-applied movement.
CREATE TABLE ledger_entries (
  seq             INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id        TEXT NOT NULL UNIQUE,
  transaction_id  TEXT NOT NULL REFERENCES transactions(id),
  entry_index     INTEGER NOT NULL,
  account_id      TEXT NOT NULL REFERENCES wallet_accounts(id),
  direction       TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_piasters INTEGER NOT NULL CHECK (amount_piasters > 0),
  balance_after   INTEGER NOT NULL,
  memo            TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  UNIQUE (transaction_id, entry_index)
);

CREATE TABLE idempotency_records (
  scope         TEXT NOT NULL,              -- e.g. 'payments.authorize' | 'deposits.create'
  key           TEXT NOT NULL,              -- client requestId
  payload_hash  TEXT NOT NULL,              -- sha256(canonicalJson(payload)) for replay-mismatch detection
  response_json TEXT,                       -- stored final response (replays reuse it verbatim)
  http_status   INTEGER,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (scope, key)
)

;

-- Hash-chained audit trail. row_hash = sha256(prev_hash || fields...); the chain
-- is computed inside BEGIN IMMEDIATE so concurrent appends can never fork.
CREATE TABLE audit_log (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  actor_type   TEXT NOT NULL,               -- customer|merchant|system|dev
  actor_id     TEXT NOT NULL,
  event        TEXT NOT NULL,               -- dotted event name, e.g. payment.authorized
  subject_type TEXT,
  subject_id   TEXT,
  outcome      TEXT NOT NULL,               -- ok | rejected | error
  data_json    TEXT NOT NULL DEFAULT '{}',  -- sanitized metadata; NEVER descriptors/photos
  prev_hash    TEXT NOT NULL,
  row_hash     TEXT NOT NULL UNIQUE
);

CREATE INDEX idx_templates_subject ON biometric_templates(subject_type, subject_id, status);
CREATE INDEX idx_txn_customer ON transactions(customer_account_id, created_at DESC);
CREATE INDEX idx_txn_merchant ON transactions(merchant_account_id, created_at DESC);
CREATE INDEX idx_txn_parent ON transactions(parent_transaction_id);
CREATE INDEX idx_ledger_account ON ledger_entries(account_id, seq);
CREATE INDEX idx_ledger_txn ON ledger_entries(transaction_id);
CREATE UNIQUE INDEX one_active_template_per_subject
  ON biometric_templates(subject_id) WHERE status = 'active';
CREATE UNIQUE INDEX txn_request_id_unique ON transactions(request_id) WHERE request_id IS NOT NULL;
