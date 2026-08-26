/**
 * Idempotency orchestration shared by deposits, payments and refunds.
 *
 * Three layers of replay protection:
 * 1. FRESHNESS — payload timestamp within ±FRESHNESS_WINDOW_MS of server clock
 *    (checked by callers before invoking this helper).
 * 2. PAYLOAD BINDING — the same requestId with a DIFFERENT payload is rejected
 *    (REPLAY_MISMATCH) instead of silently executing new instructions.
 * 3. RESPONSE REPLAY — the same requestId + payload returns the ORIGINAL result
 *    verbatim (replayed: true), never re-settling.
 *
 * An in-process in-flight map collapses concurrent duplicate submissions onto a
 * single execution; the DB row provides durability across restarts.
 */

import { ApiError, canonicalJson } from '@palmwallet/shared';
import type { PalmWalletDatabase } from '@palmwallet/db';
import { IdempotencyRepo, sha256Hex } from '@palmwallet/db';

export interface StoredOutcome<T> {
  data: T;
  httpStatus: number;
}

export interface IdempotencyResult<T> {
  data: T;
  httpStatus: number;
  replayed: boolean;
}

export class IdempotencyService {
  private readonly inflight = new Map<string, Promise<StoredOutcome<unknown>>>();

  constructor(private readonly db: PalmWalletDatabase) {}

  repo(): IdempotencyRepo {
    return new IdempotencyRepo(this.db);
  }

  hashPayload(payload: unknown): string {
    return sha256Hex(canonicalJson(payload));
  }

  /**
   * Run `op` at-most-once per (scope,key). `payloadForHash` must contain the
   * full semantic input (amounts, refs...) so mutations are detected.
   */
  async run<T>(scope: string, key: string, payloadForHash: unknown, op: () => Promise<StoredOutcome<T>>): Promise<IdempotencyResult<T>> {
    const payloadHash = this.hashPayload(payloadForHash);
    const inflightKey = `${scope}:${key}`;

    const existing = this.repo().claim(scope, key, payloadHash);
    if (existing && existing.payloadHash !== payloadHash) {
      throw new ApiError('REQUEST_REPLAY_PAYLOAD_MISMATCH', 'This requestId was already used with different content');
    }
    if (existing?.responseJson) {
      const parsed = JSON.parse(existing.responseJson) as StoredOutcome<T>;
      return { data: parsed.data, httpStatus: parsed.httpStatus, replayed: true };
    }

    // Collapse concurrent duplicates onto one execution.
    const running = this.inflight.get(inflightKey);
    if (running) {
      const out = (await running) as StoredOutcome<T>;
      return { ...out, replayed: true };
    }

    const exec = op()
      .then((out) => {
        this.repo().saveResponse(scope, key, canonicalJson({ data: out.data, httpStatus: out.httpStatus }), out.httpStatus);
        return out as StoredOutcome<unknown>;
      })
      .finally(() => {
        this.inflight.delete(inflightKey);
      });
    this.inflight.set(inflightKey, exec);
    const out = (await exec) as StoredOutcome<T>;
    return { ...out, replayed: false };
  }
}
