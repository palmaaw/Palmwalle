/**
 * Time helpers for request freshness (replay protection).
 */

export function toIso(d: Date): string {
  return d.toISOString();
}

/**
 * True when `timestampIso` is within ±`windowMs` of `nowMs`.
 * Client clocks drift; anything outside the window is treated as stale/replayed.
 */
export function isFresh(timestampIso: string, nowMs: number, windowMs: number): boolean {
  const t = Date.parse(timestampIso);
  if (!Number.isFinite(t)) return false;
  return Math.abs(nowMs - t) <= windowMs;
}
