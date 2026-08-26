/**
 * Fail-fast configuration. Secrets resolve in order: process env > .env file >
 * generated-and-persisted dev secrets (DEMO MODE ONLY) > hard error.
 *
 * Persisting generated dev secrets under data/ keeps JWTs valid and biometric
 * templates decryptable across `npm run dev` restarts without committing any
 * secret to git. Production must supply real env secrets; this path refuses to
 * boot without them when NODE_ENV=production.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { MAX_DEPOSIT_PIASTERS, MAX_PAYMENT_PIASTERS, MIN_DEPOSIT_PIASTERS, MIN_PAYMENT_PIASTERS } from '@palma/shared';
import { loadEnvFile } from './envfile.js';

export interface AppConfig {
  nodeEnv: 'development' | 'production' | 'test';
  demoMode: boolean;
  host: string;
  port: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  databasePath: string;
  jwtSecretB64: string;
  templateMasterKeyB64: string;
  templateKeyId: string;
  freshnessWindowMs: number;
  minPaymentPiasters: number;
  maxPaymentPiasters: number;
  minDepositPiasters: number;
  maxDepositPiasters: number;
  jwtTtlSeconds: number;
  devSetupToken: string;
  devToken: string;
  corsOrigins: '*' | string[];
}

function requireInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new Error(`${name} must be an integer, got: ${v}`);
  return n;
}

function b64_32bytes(name: string, value: string | undefined): string {
  if (value === undefined || value === '') throw new Error(`${name} missing (base64 of 32 random bytes)`);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32) {
    throw new Error(`${name} must decode to exactly 32 bytes (got ${bytes.length}). Generate with: openssl rand -base64 32`);
  }
  return value;
}

/** Dev-only: stable-per-install secrets cached under data/.dev-secrets.json. */
function devSecrets(databasePath: string): { jwtSecretB64: string; templateMasterKeyB64: string } {
  // ':memory:' databases get ephemeral keys (tests regenerate templates anyway).
  if (databasePath === ':memory:') {
    return {
      jwtSecretB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64'),
      templateMasterKeyB64: Buffer.from(new Uint8Array(32).fill(2)).toString('base64')
    };
  }
  const file = join(dirname(resolve(databasePath)), '.dev-secrets.json');
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { jwtSecretB64?: string; templateMasterKeyB64?: string };
      if (parsed.jwtSecretB64 && parsed.templateMasterKeyB64) {
        return { jwtSecretB64: parsed.jwtSecretB64, templateMasterKeyB64: parsed.templateMasterKeyB64 };
      }
    } catch {
      // fall through and regenerate
    }
  }
  const gen = (): string => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  const fresh = { jwtSecretB64: gen(), templateMasterKeyB64: gen() };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(fresh, null, 2));
  // eslint-disable-next-line no-console -- operator-facing startup warning
  console.warn(
    `[palma] DEMO MODE: generated dev secrets at ${file}. They are NOT production secrets; ` +
      'set JWT_SECRET and TEMPLATE_MASTER_KEY env vars for anything real.'
  );
  return fresh;
}

export function loadConfig(envFile?: string): AppConfig {
  loadEnvFile(envFile);

  const nodeEnvRaw = process.env.NODE_ENV ?? 'development';
  if (nodeEnvRaw !== 'development' && nodeEnvRaw !== 'production' && nodeEnvRaw !== 'test') {
    throw new Error(`NODE_ENV must be development|production|test, got ${nodeEnvRaw}`);
  }
  const nodeEnv = nodeEnvRaw;
  const demoMode = (process.env.DEMO_MODE ?? 'true') !== 'false';
  const databasePath = process.env.DATABASE_PATH ?? './data/palma.db';

  let jwtSecretB64: string;
  let templateMasterKeyB64: string;
  if (nodeEnv === 'production') {
    jwtSecretB64 = b64_32bytes('JWT_SECRET', process.env.JWT_SECRET);
    templateMasterKeyB64 = b64_32bytes('TEMPLATE_MASTER_KEY', process.env.TEMPLATE_MASTER_KEY);
  } else if (process.env.JWT_SECRET && process.env.TEMPLATE_MASTER_KEY) {
    jwtSecretB64 = b64_32bytes('JWT_SECRET', process.env.JWT_SECRET);
    templateMasterKeyB64 = b64_32bytes('TEMPLATE_MASTER_KEY', process.env.TEMPLATE_MASTER_KEY);
  } else {
    if (!demoMode) throw new Error('JWT_SECRET and TEMPLATE_MASTER_KEY are required unless DEMO_MODE=true');
    ({ jwtSecretB64, templateMasterKeyB64 } = devSecrets(databasePath));
  }

  const corsRaw = process.env.CORS_ORIGINS ?? '*';
  const corsOrigins = corsRaw === '*' ? '*' : corsRaw.split(',').map((s) => s.trim()).filter(Boolean);

  return {
    nodeEnv,
    demoMode,
    host: process.env.HOST ?? '0.0.0.0',
    port: requireInt('PORT', 8787),
    logLevel: (process.env.LOG_LEVEL as AppConfig['logLevel']) ?? 'info',
    databasePath,
    jwtSecretB64,
    templateMasterKeyB64,
    templateKeyId: process.env.TEMPLATE_KEY_ID ?? 'k1',
    freshnessWindowMs: requireInt('FRESHNESS_WINDOW_MS', 5 * 60_000),
    minPaymentPiasters: requireInt('MIN_PAYMENT_PIASTERS', MIN_PAYMENT_PIASTERS),
    maxPaymentPiasters: requireInt('MAX_PAYMENT_PIASTERS', MAX_PAYMENT_PIASTERS),
    minDepositPiasters: requireInt('MIN_DEPOSIT_PIASTERS', MIN_DEPOSIT_PIASTERS),
    maxDepositPiasters: requireInt('MAX_DEPOSIT_PIASTERS', MAX_DEPOSIT_PIASTERS),
    jwtTtlSeconds: requireInt('JWT_TTL_SECONDS', 43_200),
    devSetupToken: process.env.DEV_SETUP_TOKEN ?? 'palma-dev-setup',
    devToken: process.env.DEV_TOKEN ?? 'palma-dev',
    corsOrigins
  };
}
