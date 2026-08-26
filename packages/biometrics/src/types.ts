/**
 * Core types for the SIMULATED biometric pipeline.
 *
 * This package must stay free of `node:*` imports and DOM-only globals (WebCrypto
 * via `globalThis.crypto` is available in both runtimes) so the EXACT SAME code
 * extracts descriptors in the browser and protects/matches them on the server.
 *
 * ⚠️ SIMULATED / PROTOTYPE-GRADE. See docs/BIOMETRICS.md. Replace with a certified
 * biometric SDK before any production use.
 */

import type { PalmCodeDTO, QualityHint, QualityReportDTO } from '@palmwallet/shared';

/** Single-channel image, values in [0,1]. */
export interface GrayImage {
  width: number;
  height: number;
  data: Float32Array;
}

/** Continuous feature vector (pre-projection). */
export interface DescriptorVector {
  dim: number;
  f: Float32Array;
}

/** Wire form of a protected template code (1024 packed bits, base64). */
export type { PalmCodeDTO as PalmCode };

export type { QualityHint, QualityReportDTO as QualityReport };

export interface ExtractResult {
  vector: DescriptorVector;
  quality: QualityReportDTO;
}

export interface FeatureExtractor {
  /** Runs normalize -> HOG and reports quality of the raw image. */
  extract(img: GrayImage): ExtractResult;
}

/** Packed binary protected template (before encryption), TEMPLATE_BITS bits. */
export interface BinaryTemplate {
  bits: Uint8Array; // packed, length = TEMPLATE_BITS / 8
}

export interface SealedTemplate {
  ciphertext: Uint8Array; // AES-256-GCM nonce || ct || tag
  keyId: string;
}

export type Decision = 'match' | 'no_match' | 'ambiguous';

export interface ScoreResult {
  similarity: number; // 1 - hamming/bits, in [0,1]
  threshold: number;
  greyZone: boolean; // between greyFloor and threshold: rejected but suspicious
  decision: Decision;
}

export interface CandidateTemplate {
  templateId: string;
  subjectId: string;
  bits: Uint8Array;
}

export interface BestMatchResult extends ScoreResult {
  subjectId: string | null;
  templateId: string | null;
  examined: number; // how many templates were compared
  runnerUp?: { subjectId: string; similarity: number };
}

/** Storage seam implemented by @palmwallet/db (sqlite) or in-memory (tests). */
export interface TemplateStoreRow {
  templateId: string;
  subjectType: string;
  subjectId: string;
  sealed: SealedTemplate;
}

export interface TemplateStore {
  insert(row: {
    templateId: string;
    subjectType: string;
    subjectId: string;
    algoId: string;
    algoVersion: string;
    descriptorDim: number;
    bits: number;
    keyId: string;
    sealed: SealedTemplate;
    qualityScore: number;
    captureSource: 'camera' | 'synthetic';
  }): Promise<void>;
  /** Active (non-revoked) templates, optionally restricted to a subject type. */
  listActive(subjectType?: string): Promise<TemplateStoreRow[]>;
  getBySubject(subjectType: string, subjectId: string): Promise<TemplateStoreRow[]>;
  getById(templateId: string): Promise<TemplateStoreRow | null>;
  /** Revoke all active templates of a subject; returns count revoked. */
  revokeActive(subjectType: string, subjectId: string, exceptId?: string): Promise<number>;
  revokeById(templateId: string): Promise<void>;
}

export interface EnrollInput {
  subjectType: 'customer';
  subjectId: string;
  /**
   * Packed TEMPLATE_BITS-bit code produced ON DEVICE (combine frames ->
   * random projection -> sign binarize). The server never receives vectors and
   * cannot protect descriptors itself — by design.
   */
  code: Uint8Array;
  quality: QualityReportDTO;
  captureSource: 'camera' | 'synthetic';
  /**
   * Device-attested repeatability (min pairwise cosine among enrollment
   * frames). Self-reported because raw frames never reach the server; the
   * server enforces a floor and the audit trail keeps the value.
   */
  consistencyScore: number;
}

export interface EnrollOutput {
  templateId: string;
  consistencyScore: number; // attested value echoed for audit/UX
}

/**
 * THE swappable seam. A certified biometric SDK replaces this interface (and the
 * extraction pipeline) without touching payment/account layers.
 *
 * Every method accepts ALREADY-PROTECTED codes: irreversible templating happens
 * exclusively on capture devices holding the protection subkey. The server only
 * ever stores sealed codes and matches them by Hamming distance in memory.
 */
export interface BiometricService {
  readonly algo: {
    id: string;
    version: string;
    threshold: number;
    greyFloor: number;
    bits: number;
    dim: number;
  };
  /**
   * The device-visible protection subkey (HKDF-derived from the master).
   * Served ONLY to authenticated capture clients so they can protect scans
   * locally. Deliberately NOT the storage subkey, which never leaves the
   * server. Prototype-grade custody: production readers hold their own keys in
   * secure hardware instead of fetching this.
   */
  readonly protectionKeyB64: string;
  enrollPalm(x: EnrollInput): Promise<EnrollOutput>;
  /** 1:1 verification against one subject's active template. */
  verifyPalm(code: Uint8Array, x: { subjectType: 'customer'; subjectId: string }): Promise<BestMatchResult>;
  /** 1:N identification against all active customer templates. */
  identifyPalm(code: Uint8Array, opts?: { candidateSubjectIds?: string[] }): Promise<BestMatchResult>;
  /** Soft-revoke (rows retained for audit). */
  deleteTemplate(templateId: string): Promise<void>;
}

export class IntegrityError extends Error {
  constructor(message = 'Template integrity check failed') {
    super(message);
    this.name = 'IntegrityError';
  }
}
