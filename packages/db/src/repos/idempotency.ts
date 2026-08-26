/**
 * Idempotency records: (scope, requestId) -> payload hash + stored response.
 * A replayed request with an IDENTICAL payload re-serves the stored response;
 * the same key with a DIFFERENT payload is a programming error / tamper and is
 * rejected (REPLAY_MISMATCH at the API layer).
 */

import { nowIso, PalmWalletDatabase } from '../database.js';
import type { IdempotencyRow } from '../rows.js';

const COLS =
  'scope, key, payload_hash AS payloadHash, response_json AS responseJson, ' +
  'http_status AS httpStatus, created_at AS createdAt';

export class IdempotencyRepo {
  constructor(private readonly db: PalmWalletDatabase) {}

  get(scope: string, key: string): IdempotencyRow | null {
    return (this.db
      .stmt(`SELECT ${COLS} FROM idempotency_records WHERE scope = ? AND key = ?`)
      .get(scope, key) ?? null) as IdempotencyRow | null;
  }

  /**
   * Claim a request slot. Returns the PRE-EXISTING row for (scope,key), or null
   * when this call created it (first sighting → caller proceeds normally).
   * Callers compare payloadHash and branch: mismatch -> reject; existing
   * response -> replay it; else run the operation and saveResponse().
   */
  claim(scope: string, key: string, payloadHash: string): IdempotencyRow | null {
    const before = this.get(scope, key);
    if (before) return before;
    try {
      this.db
        .stmt('INSERT INTO idempotency_records (scope, key, payload_hash, created_at) VALUES (?, ?, ?, ?)')
        .run(scope, key, payloadHash, nowIso());
      return null;
    } catch {
      // Lost a race with a concurrent claim of the same (scope,key).
      return this.get(scope, key);
    }
  }

  /** Store the final response so replays return byte-identical results. */
  saveResponse(scope: string, key: string, responseJson: string, httpStatus: number): void {
    this.db
      .stmt(
        `UPDATE idempotency_records SET response_json = ?, http_status = ?
         WHERE scope = ? AND key = ?`
      )
      .run(responseJson, httpStatus, scope, key);
  }
}
