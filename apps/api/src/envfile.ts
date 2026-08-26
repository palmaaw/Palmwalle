/**
 * Minimal .env loader (KEY=VALUE lines, # comments, optional quotes).
 * Process env ALWAYS wins over file values. No dependency on dotenv.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadEnvFile(explicitPath?: string): void {
  const candidates = [
    explicitPath,
    join(process.cwd(), '.env'),
    join(process.cwd(), '..', '.env'),
    join(process.cwd(), '..', '..', '.env')
  ].filter((p): p is string => typeof p === 'string');

  const path = candidates.find((p) => existsSync(p));
  if (!path) return;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }

  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}
