/**
 * Password hashing with SALTED scrypt + timing-safe verification.
 *
 * Passwords are the account credential for this prototype; they are NEVER
 * stored in plaintext and NEVER logged. Stored format:
 *   scrypt$N$r$p$saltB64$hashB64
 * The per-password random salt defeats rainbow tables; scrypt's memory cost
 * keeps GPU/ASIC brute-force expensive if the database leaks.
 * (Real deployments should use Argon2id and review KDF work factors.)
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

/** Synchronous on purpose — login/register paths pay one ~50ms KDF pass,
 *  and call sites stay await-free. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, nStr, rStr, pStr, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(nStr),
      r: Number(rStr),
      p: Number(pStr)
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
