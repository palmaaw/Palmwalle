/**
 * Checksummed migration runner. Every applied migration's sha256 is recorded;
 * re-running against a database whose recorded checksum no longer matches the
 * file REFUSES to run (drift means someone edited history).
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nowIso, PalmWalletDatabase } from './database.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface AppliedMigration {
  name: string;
  checksum: string;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function runMigrations(db: PalmWalletDatabase): AppliedMigration[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  if (files.length === 0) throw new Error(`no migrations found in ${MIGRATIONS_DIR}`);

  const priorRows = db.stmt('SELECT name, checksum FROM _migrations ORDER BY name').all() as Array<{
    name: string;
    checksum: string;
  }>;
  const prior = new Map(priorRows.map((r) => [r.name, r.checksum]));

  const newlyApplied: AppliedMigration[] = [];
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = sha256Hex(sql);
    const seen = prior.get(file);
    if (seen !== undefined) {
      if (seen !== checksum) {
        throw new Error(
          `migration checksum drift: ${file} was applied as ${seen} but is now ${checksum}. ` +
            'Applied migrations are immutable — add a NEW migration file instead.'
        );
      }
      continue;
    }
    // Each migration applies atomically with its bookkeeping row.
    db.withTransaction(() => {
      db.exec(sql);
      db.stmt('INSERT INTO _migrations (name, checksum, applied_at) VALUES (?, ?, ?)').run(
        file,
        checksum,
        nowIso()
      );
    });
    newlyApplied.push({ name: file, checksum });
  }

  return db
    .stmt('SELECT name, checksum FROM _migrations ORDER BY name')
    .all() as Array<{ name: string; checksum: string }>;
}
