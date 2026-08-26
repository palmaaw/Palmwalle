/**
 * BiometricService implementation over a TemplateStore.
 *
 * ⚠️ SIMULATED / PROTOTYPE. The interface (enrollPalm / verifyPalm /
 * identifyPalm / deleteTemplate) is the seam a certified biometric SDK must
 * replace before production.
 *
 * SECURITY POSTURE (device-side protection):
 *  - Every method accepts ALREADY-PROTECTED 1024-bit codes produced on the
 *    capture device with the protection subkey. The server has NO code path
 *    that turns vectors into codes, so descriptors cannot be smuggled in.
 *  - Codes are sealed at rest with AES-256-GCM under the SEPARATE storage
 *    subkey; a stolen database yields ciphertext that is useless without it,
 *    and the protection subkey deliberately cannot open it.
 *  - Matching decrypts stored bits ephemerally in process memory and compares
 *    by Hamming distance; plaintext bits are never persisted or logged.
 */

import {
  ALGO_ID,
  ALGO_VERSION,
  DESCRIPTOR_DIM,
  ENROLL_CONSISTENCY_FLOOR,
  MATCH_GREY_FLOOR,
  MATCH_THRESHOLD,
  TEMPLATE_BITS,
  newId
} from '@palma/shared';
import { bestMatch } from './match/matcher.js';
import { decodeCode } from './codes.js';
import { bytesToBase64 } from './base64.js';
import { openSealed, sealBits } from './protect/cipher.js';
import type {
  BestMatchResult,
  BiometricService,
  EnrollInput,
  EnrollOutput,
  SealedTemplate,
  TemplateStore
} from './types.js';

export interface ServiceDeps {
  store: TemplateStore;
  /** 32-byte HKDF subkey for one-way protection — ships to capture devices. */
  protectionKey: Uint8Array;
  /** 32-byte HKDF subkey for AES-GCM sealing at rest — server-only. */
  storageKey: Uint8Array;
  keyId: string;
  threshold?: number;
}

export function createBiometricService(deps: ServiceDeps): BiometricService {
  const { store, protectionKey, storageKey, keyId } = deps;
  const threshold = deps.threshold ?? MATCH_THRESHOLD;

  // Ephemeral cache of decrypted bits per template id; entries die with the process.
  const bitsCache = new Map<string, Uint8Array>();

  function aad(subjectType: string, subjectId: string, templateId: string): string {
    return `${subjectType}:${subjectId}:${templateId}`;
  }

  async function decryptBits(
    row: { templateId: string; subjectType: string; subjectId: string; sealed: SealedTemplate }
  ): Promise<Uint8Array> {
    const cached = bitsCache.get(row.templateId);
    if (cached) return cached;
    const sealedWithKey: SealedTemplate = { ciphertext: row.sealed.ciphertext, keyId };
    const bits = await openSealed(sealedWithKey, storageKey, aad(row.subjectType, row.subjectId, row.templateId));
    bitsCache.set(row.templateId, bits);
    return bits;
  }

  return {
    algo: {
      id: ALGO_ID,
      version: ALGO_VERSION,
      threshold,
      greyFloor: MATCH_GREY_FLOOR,
      bits: TEMPLATE_BITS,
      dim: DESCRIPTOR_DIM
    },

    protectionKeyB64: bytesToBase64(protectionKey),

    async enrollPalm(x: EnrollInput): Promise<EnrollOutput> {
      // Code validation FIRST: wrong size/algo never reaches crypto or storage.
      decodeCode({ algoId: ALGO_ID, version: 1, bits: bytesToBase64(x.code) });
      if (!x.quality.usable) throw new Error('capture quality too low to enroll');
      // Device-attested repeatability floor: raw frames never arrive, so this is
      // self-reported — enforced as a sanity bound, not a cryptographic guarantee.
      if (!(x.consistencyScore >= ENROLL_CONSISTENCY_FLOOR)) {
        throw new Error('enrollment frames inconsistent — recapture');
      }
      const templateId = newId();
      // Partial unique index enforces one active template; revoke any previous first.
      await store.revokeActive(x.subjectType, x.subjectId);
      const sealed = await sealBits(x.code, storageKey, aad(x.subjectType, x.subjectId, templateId));
      sealed.keyId = keyId;
      await store.insert({
        templateId,
        subjectType: x.subjectType,
        subjectId: x.subjectId,
        algoId: ALGO_ID,
        algoVersion: ALGO_VERSION,
        descriptorDim: DESCRIPTOR_DIM,
        bits: TEMPLATE_BITS,
        keyId,
        sealed,
        qualityScore: x.quality.score,
        captureSource: x.captureSource
      });
      bitsCache.delete(templateId);
      return { templateId, consistencyScore: x.consistencyScore };
    },

    async verifyPalm(code, x): Promise<BestMatchResult> {
      decodeCode({ algoId: ALGO_ID, version: 1, bits: bytesToBase64(code) });
      const rows = await store.getBySubject(x.subjectType, x.subjectId);
      const candidates = [];
      for (const r of rows) {
        candidates.push({
          templateId: r.templateId,
          subjectId: r.subjectId,
          bits: await decryptBits(r)
        });
      }
      return bestMatch(code, candidates, { threshold });
    },

    async identifyPalm(code, opts): Promise<BestMatchResult> {
      decodeCode({ algoId: ALGO_ID, version: 1, bits: bytesToBase64(code) });
      const rows = await store.listActive('customer');
      const wanted = opts?.candidateSubjectIds ? new Set(opts.candidateSubjectIds) : null;
      const candidates = [];
      for (const r of rows) {
        if (wanted && !wanted.has(r.subjectId)) continue;
        candidates.push({
          templateId: r.templateId,
          subjectId: r.subjectId,
          bits: await decryptBits(r)
        });
      }
      return bestMatch(code, candidates, { threshold });
    },

    async deleteTemplate(templateId: string): Promise<void> {
      await store.revokeById(templateId);
      bitsCache.delete(templateId);
    }
  };
}
