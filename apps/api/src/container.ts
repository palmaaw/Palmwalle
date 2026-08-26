/**
 * Composition root: build the database, repos, biometric service and services
 * from config. Everything the routes need hangs off AppContext — no globals.
 */

import { createBiometricService, deriveRuntimeKeys } from '@palmwallet/biometrics';
import type { BiometricService } from '@palmwallet/biometrics';
import { AccountRepo, AuditRepo, CustomerRepo, IdempotencyRepo, LedgerRepo, MerchantRepo, PalmWalletDatabase, SqliteTemplateStore, TransactionRepo, runMigrations } from '@palmwallet/db';
import type { AuthHooks } from './plugins/auth.js';
import { authHooks } from './plugins/auth.js';

import type { AppConfig } from './config.js';
import { IdempotencyService } from './services/idempotency.js';
import { LedgerService } from './services/ledgerService.js';
import { PaymentService } from './services/paymentService.js';
import { LoginThrottle, ProbeThrottle } from './security/throttle.js';
import { TokenService } from './security/tokens.js';
import { ProviderRegistry } from './providers/registry.js';

export interface AppContext {
  config: AppConfig;
  db: PalmWalletDatabase;
  repos: {
    customers: CustomerRepo;
    merchants: MerchantRepo;
    accounts: AccountRepo;
    txns: TransactionRepo;
    ledgerEntries: LedgerRepo;
    idempotency: IdempotencyRepo;
    audit: AuditRepo;
  };
  biometrics: BiometricService;
  templates: SqliteTemplateStore;
  tokens: TokenService;
  auth: AuthHooks;
  throttle: LoginThrottle;
  probeThrottle: ProbeThrottle;
  providers: ProviderRegistry;
  ledger: LedgerService;
  payments: PaymentService;
  idem: IdempotencyService;
}

export async function buildContext(config: AppConfig): Promise<AppContext> {
  const db = new PalmWalletDatabase(config.databasePath);
  runMigrations(db);

  const repos = {
    customers: new CustomerRepo(db),
    merchants: new MerchantRepo(db),
    accounts: new AccountRepo(db),
    txns: new TransactionRepo(db),
    ledgerEntries: new LedgerRepo(db),
    idempotency: new IdempotencyRepo(db),
    audit: new AuditRepo(db)
  };

  // Templates persist as AES-GCM ciphertext through the SQLite store.
  // The master key is split via HKDF into two purpose-separated subkeys:
  //  - protectionKey: served to authenticated capture devices (they protect
  //    scans locally; descriptors never reach this server)
  //  - storageKey: never leaves the process; seals templates at rest
  const templates = new SqliteTemplateStore(db);
  const masterKey = new Uint8Array(Buffer.from(config.templateMasterKeyB64, 'base64'));
  const { protectionKey, storageKey } = await deriveRuntimeKeys(masterKey);
  const biometrics = createBiometricService({
    store: templates,
    protectionKey,
    storageKey,
    keyId: config.templateKeyId
  });

  const tokens = new TokenService(config.jwtSecretB64, config.jwtTtlSeconds);
  const auth = authHooks(tokens);
  const throttle = new LoginThrottle();
  // Per-merchant probe budget (score-oracle mitigation); per-customer self-test
  // budget lives in the palm routes.
  const probeThrottle = new ProbeThrottle();
  const providers = new ProviderRegistry();
  const idem = new IdempotencyService(db);
  const ledger = new LedgerService(db);
  const payments = new PaymentService({
    ledger,
    idempotency: idem,
    biometrics,
    customers: repos.customers,
    probeThrottle,
    freshnessWindowMs: config.freshnessWindowMs
  });

  return { config, db, repos, biometrics, templates, tokens, auth, throttle, probeThrottle, providers, ledger, payments, idem };
}
