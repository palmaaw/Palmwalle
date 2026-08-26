/**
 * Deterministic PRNG utilities (integer math only — identical output in every
 * JS engine, which matters because the synthetic palms and the projection matrix
 * must be reproducible across browsers, Node and CI).
 */

/** xmur3 string hash -> 32-bit seed generator. */
export function hashString(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

export interface Rng {
  /** Uniform float in [0,1). */
  next(): number;
  /** Uniform float in [min,max). */
  range(min: number, max: number): number;
  /** Approximate standard normal (Box-Muller, cached spare). */
  gauss(): number;
  int(maxExclusive: number): number;
}

/** sfc32 PRNG seeded from four 32-bit words. Small, fast, statistically fine for simulation. */
export function makeRng(...seeds: number[]): Rng {
  let a = seeds[0] ?? 0 >>> 0;
  let b = seeds[1] ?? 0x9e3779b9 >>> 0;
  let c = seeds[2] ?? 0x85ebca6b >>> 0;
  let d = seeds[3] ?? 0xc2b2ae35 >>> 0;
  const warm = (): void => {
    // 20 warmup rounds to diffuse weak seeds
    for (let i = 0; i < 20; i++) sfc();
  };
  const sfc = (): number => {
    const t = (a + b) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) >>> 0;
    const out = (t + d) >>> 0;
    c = (c + t) >>> 0;
    return out;
  };
  warm();
  let spare: number | null = null;
  return {
    next(): number {
      return sfc() / 4294967296;
    },
    range(min, max): number {
      return min + (max - min) * (sfc() / 4294967296);
    },
    gauss(): number {
      if (spare !== null) {
        const s = spare;
        spare = null;
        return s;
      }
      const u = Math.max(sfc() / 4294967296, 1e-12);
      const v = sfc() / 4294967296;
      const mag = Math.sqrt(-2 * Math.log(u));
      spare = mag * Math.sin(2 * Math.PI * v);
      return mag * Math.cos(2 * Math.PI * v);
    },
    int(maxExclusive): number {
      return Math.floor((sfc() / 4294967296) * maxExclusive) % maxExclusive;
    }
  };
}

/** Seeded rng from an arbitrary string (avalanche-mixed via repeated hashing). */
export function rngFromString(str: string): Rng {
  let h = hashString(str);
  const words: number[] = [];
  for (let i = 0; i < 4; i++) {
    // Re-hash with round constants so the four state words decorrelate.
    h = hashString(`${str}|${h.toString(16)}|${i}`);
    words.push(h);
  }
  return makeRng(words[0]!, words[1]!, words[2]!, words[3]!);
}

/**
 * Seeded rng from raw key bytes. Each word is an independent full re-hash of the
 * key material — critical for the projection matrix, where correlated PRNG
 * output produces correlated matrix rows and distorted bit similarities.
 */
export function rngFromBytes(key: Uint8Array): Rng {
  const words: number[] = [];
  for (let i = 0; i < 4; i++) {
    words.push(hashString(`palm-wallet-key-seed:${i}:${toHex(key)}`));
  }
  return makeRng(words[0]!, words[1]!, words[2]!, words[3]!);
}

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
