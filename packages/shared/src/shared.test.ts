import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical.js';
import { formatAmount, formatEGP, toPiasters } from './money.js';
import { newHumanRef, newId } from './ids.js';
import { isFresh } from './time.js';

describe('money', () => {
  it('parses EGP strings into integer piasters', () => {
    expect(toPiasters('12.50')).toBe(1250);
    expect(toPiasters('12.5')).toBe(1250);
    expect(toPiasters('12')).toBe(1200);
    expect(toPiasters('0.01')).toBe(1);
    expect(toPiasters(7.3)).toBe(730);
  });

  it('rejects malformed amounts instead of truncating', () => {
    expect(() => toPiasters('12.345')).toThrow();
    expect(() => toPiasters('-5')).toThrow();
    expect(() => toPiasters('abc')).toThrow();
    expect(() => toPiasters(NaN)).toThrow();
    expect(() => toPiasters('')).toThrow();
  });

  it('formats piasters back to strings', () => {
    expect(formatEGP(1250)).toBe('EGP 12.50');
    expect(formatEGP(1)).toBe('EGP 0.01');
    expect(formatAmount(-250)).toBe('-2.50');
  });
});

describe('canonicalJson', () => {
  it('is order-independent for identical payloads', () => {
    const a = { b: 1, a: { y: [1, 2], x: 's' } };
    const b = { a: { x: 's', y: [1, 2] }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('drops undefined values deterministically', () => {
    expect(canonicalJson({ a: undefined, b: 2 })).toBe(canonicalJson({ b: 2 }));
  });

  it('preserves array order (arrays are ordered by contract)', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe('ids', () => {
  it('generates unique UUIDs', () => {
    const seen = new Set(Array.from({ length: 100 }, () => newId()));
    expect(seen.size).toBe(100);
  });

  it('formats human refs with kind, date and random tail', () => {
    const ref = newHumanRef('PM', new Date('2026-08-25T10:00:00Z'));
    expect(ref).toMatch(/^PM-20260825-[A-HJ-NP-Z2-9]{6}$/);
  });
});

describe('freshness', () => {
  const now = Date.parse('2026-08-25T12:00:00Z');
  const window = 5 * 60_000;
  it('accepts within window', () => {
    expect(isFresh('2026-08-25T11:57:00Z', now, window)).toBe(true);
    expect(isFresh('2026-08-25T12:04:59Z', now, window)).toBe(true);
  });
  it('rejects stale or future-dated requests', () => {
    expect(isFresh('2026-08-25T11:54:00Z', now, window)).toBe(false);
    expect(isFresh('2026-08-25T13:00:00Z', now, window)).toBe(false);
    expect(isFresh('not-a-date', now, window)).toBe(false);
  });
});
