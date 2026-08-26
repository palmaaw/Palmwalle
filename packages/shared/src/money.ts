/**
 * Money helpers. All amounts in the system are integer piasters (1 EGP = 100 piasters).
 * Floats never cross a boundary: parse strings here, format strings here.
 */

export type Piasters = number;

const AMOUNT_RE = /^\d{1,9}(\.\d{1,2})?$/;

/** Parse an EGP amount ("12.50", "12", 12.5) into integer piasters. Throws on bad input. */
export function toPiasters(egp: string | number): Piasters {
  let s: string;
  if (typeof egp === 'number') {
    if (!Number.isFinite(egp)) throw new Error(`Invalid amount: ${egp}`);
    // Guard against float repr noise like 12.300000000000001 from upstream inputs.
    s = egp.toFixed(2);
    if (!AMOUNT_RE.test(s)) throw new Error(`Invalid amount: ${egp}`);
  } else {
    s = egp.trim();
  }
  if (!AMOUNT_RE.test(s)) throw new Error(`Invalid EGP amount: ${String(egp)}`);
  const [whole, frac = ''] = s.split('.');
  const fracPad = frac.padEnd(2, '0');
  return Number(whole) * 100 + Number(fracPad);
}

/** Format piasters as an EGP string, e.g. 1250 -> "EGP 12.50". */
export function formatEGP(p: Piasters): string {
  if (!Number.isInteger(p)) throw new Error(`Non-integer piasters: ${p}`);
  const sign = p < 0 ? '-' : '';
  const abs = Math.abs(p);
  return `${sign}EGP ${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Format piasters without the currency prefix, e.g. 1250 -> "12.50". */
export function formatAmount(p: Piasters): string {
  if (!Number.isInteger(p)) throw new Error(`Non-integer piasters: ${p}`);
  const sign = p < 0 ? '-' : '';
  const abs = Math.abs(p);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
