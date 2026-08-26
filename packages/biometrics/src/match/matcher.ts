/**
 * Hamming matching over protected binary templates with decision bands and an
 * ambiguity rule (two different subjects scoring near-equally -> refuse rather
 * than guess).
 */

import { AMBIGUITY_MARGIN, MATCH_GREY_FLOOR, MATCH_THRESHOLD, TEMPLATE_BITS } from '@palma/shared';
import type { BestMatchResult, CandidateTemplate } from '../types.js';

const POP16 = buildPop16();

function buildPop16(): Uint8Array {
  const t = new Uint8Array(65536);
  for (let i = 1; i < 65536; i++) t[i] = (t[i >> 1]! + (i & 1)) as number;
  return t;
}

export function popcount(x: number): number {
  return POP16[x & 0xffff]! + POP16[(x >>> 16) & 0xffff]!;
}

export function hammingDistance(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) throw new Error(`bit length mismatch ${a.length} vs ${b.length}`);
  let d = 0;
  // Compare 16 bits at a time via DataView-free pairing.
  for (let i = 0; i < a.length; i += 2) {
    const av = (a[i]!) | ((a[i + 1] ?? 0) << 8);
    const bv = (b[i]!) | ((b[i + 1] ?? 0) << 8);
    d += popcount((av ^ bv) & 0xffff);
  }
  return d;
}

export interface CompareOptions {
  threshold?: number;
  greyFloor?: number;
}

export function compareTemplates(a: Uint8Array, b: Uint8Array, opts: CompareOptions = {}): {
  similarity: number;
  greyZone: boolean;
  decision: 'match' | 'no_match';
} {
  const threshold = opts.threshold ?? MATCH_THRESHOLD;
  const greyFloor = opts.greyFloor ?? MATCH_GREY_FLOOR;
  const similarity = 1 - hammingDistance(a, b) / TEMPLATE_BITS;
  const decision = similarity >= threshold ? 'match' : 'no_match';
  return { similarity, greyZone: !!(decision === 'no_match' && similarity >= greyFloor), decision };
}

/**
 * 1:N best match. Ambiguity rule: if the runner-up belongs to a DIFFERENT subject,
 * both are above threshold and within AMBIGUITY_MARGIN, refuse instead of guessing.
 */
export function bestMatch(
  probeBits: Uint8Array,
  candidates: CandidateTemplate[],
  opts: CompareOptions = {}
): BestMatchResult {
  const threshold = opts.threshold ?? MATCH_THRESHOLD;
  const greyFloor = opts.greyFloor ?? MATCH_GREY_FLOOR;
  let best: { candidate: CandidateTemplate; sim: number } | null = null;
  let runnerUpSameSubject: number | null = null;
  let runnerUpOther: { subjectId: string; sim: number } | null = null;

  for (const c of candidates) {
    const sim = 1 - hammingDistance(probeBits, c.bits) / TEMPLATE_BITS;
    if (!best || sim > best.sim) {
      if (best) {
        if (best.candidate.subjectId === c.subjectId) {
          runnerUpSameSubject = Math.max(runnerUpSameSubject ?? -1, best.sim);
        } else {
          runnerUpOther = { subjectId: best.candidate.subjectId, sim: best.sim };
        }
      }
      best = { candidate: c, sim };
    } else {
      if (c.subjectId === best.candidate.subjectId) {
        runnerUpSameSubject = Math.max(runnerUpSameSubject ?? -1, sim);
      } else if (!runnerUpOther || sim > runnerUpOther.sim) {
        runnerUpOther = { subjectId: c.subjectId, sim };
      }
    }
  }

  if (!best) {
    return { similarity: 0, threshold, greyZone: false, decision: 'no_match', subjectId: null, templateId: null, examined: 0 };
  }

  const { candidate, sim } = best;
  const decision = sim >= threshold ? 'match' : 'no_match';
  const greyZone = decision === 'no_match' && sim >= greyFloor;

  const ambiguous =
    decision === 'match' &&
    runnerUpOther !== null &&
    runnerUpOther.sim >= threshold &&
    Math.abs(sim - runnerUpOther.sim) <= AMBIGUITY_MARGIN;

  return {
    similarity: round4(sim),
    threshold,
    greyZone,
    decision: ambiguous ? 'ambiguous' : decision,
    subjectId: ambiguous ? null : decision === 'match' ? candidate.subjectId : null,
    templateId: ambiguous ? null : decision === 'match' ? candidate.templateId : null,
    examined: candidates.length,
    ...(runnerUpOther ? { runnerUp: { subjectId: runnerUpOther.subjectId, similarity: round4(runnerUpOther.sim) } } : {})
  };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
