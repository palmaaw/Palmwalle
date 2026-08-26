/**
 * PalmaDatabase — the ONLY module in PalmPay that touches node:sqlite.
 *
 * Why a wrapper: node:sqlite's DatabaseSync has no `.transaction()` helper, and
 * SQLite allows only one writer at a time. `withTransaction()` below replaces the
 * missing helper using BEGIN IMMEDIATE (take the write lock UP FRONT so a tx that
 * reads-then-writes cannot be upgraded-and-conflicted midway) with BUSY retries on
 * top of the connection-level busy_timeout.
 *
 * Concurrency note: every async repo method here is synchronous underneath
 * (DatabaseSync does blocking local I/O only), so a transaction body never yields
 * to the event loop mid-flight and two overlapping calls can never interleave
 * statements. Cross-PROCESS serialization comes from SQLite's own locking +
 * busy_timeout; multi-instance deployment is out of prototype scope.
 *
 * All timestamps stored as UTC ISO-8601 strings; all money as integer piasters.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';

export class PalmaDatabase {
  readonly raw: DatabaseSync;
  private depth = 0;
  private readonly stmtCache = new Map<string, StatementSync>();

  constructor(path: string, opts: { busyTimeoutMs?: number } = {}) {
    this.raw = new DatabaseSync(path);
    // WAL lets readers proceed while a writer commits; :memory: keeps mode 'memory'.
    this.raw.exec('PRAGMA journal_mode = WAL;');
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec(`PRAGMA busy_timeout = ${opts.busyTimeoutMs ?? 5000};`);
    this.raw.exec('PRAGMA synchronous = NORMAL;');
  }

  /** Prepared-statement cache — SQL strings in this package are static literals. */
  stmt(sql: string): StatementSync {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  /**
   * Run `fn` inside BEGIN IMMEDIATE ... COMMIT — SYNCHRONOUSLY.
   *
   * Nested calls JOIN the enclosing transaction (SQLite has no independent
   * nesting without savepoints; repos compose inside one outer transaction per
   * request). An async callback is REJECTED outright: awaiting anything inside a
   * transaction would hold the write lock across the await and let unrelated
   * requests interleave into the same SQLite transaction. All persistence work
   * in PalmPay is synchronous node:sqlite I/O, so nothing legitimate needs it —
   * biometric matching and other async steps run BEFORE opening the transaction.
   */
  withTransaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.beginImmediate();
    this.depth++;
    try {
      const out = fn();
      if (out instanceof Promise) {
        throw new Error(
          'withTransaction callback returned a Promise — transaction bodies must be synchronous'
        );
      }
      this.raw.exec('COMMIT;');
      return out;
    } catch (err) {
      try {
        this.raw.exec('ROLLBACK;');
      } catch {
        // Transaction was already rolled back (e.g. the failing statement aborted it).
      }
      throw err;
    } finally {
      this.depth--;
    }
  }

  private beginImmediate(attempts = 4): void {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        this.raw.exec('BEGIN IMMEDIATE;');
        return;
      } catch (err) {
        lastErr = err;
        // busy_timeout absorbs contention; this loop is defense-in-depth for
        // immediate-BUSY storms. Retries are cheap and immediate.
        const msg = String((err as Error | null)?.message ?? err);
        if (!msg.toUpperCase().includes('BUSY')) throw err;
      }
    }
    throw lastErr;
  }

  close(): void {
    this.raw.close();
  }
}

/** Canonical timestamp for stored rows (UTC ISO-8601). */
export function nowIso(): string {
  return new Date().toISOString();
}
