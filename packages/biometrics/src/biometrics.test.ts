/// <reference types="node" />
// Tests run under Node (vitest); Buffer is fine HERE — src/ stays runtime-neutral.
import { describe, expect, it } from 'vitest';
import { ENROLL_CONSISTENCY_FLOOR, MATCH_GREY_FLOOR, MATCH_THRESHOLD } from '@palma/shared';
import {
  InMemoryTemplateStore,
  SyntheticCaptureSource,
  buildEnrollmentCode,
  buildProbeCode,
  combineVectors,
  createBiometricService,
  demoSeed,
  deriveRuntimeKeys,
  encodeCode,
  extractFromGray,
  hammingDistance,
  packBits,
  protectVector,
  renderSyntheticPalm,
  unpackBits,
  bestMatch,
  sealBits,
  openSealed,
  IntegrityError
} from './index.js';
import type { QualityHint } from './types.js';

const PROTECTION_KEY = new Uint8Array(32).fill(7);
const STORAGE_KEY = new Uint8Array(32).fill(11);

function makeService() {
  const store = new InMemoryTemplateStore();
  return {
    service: createBiometricService({ store, protectionKey: PROTECTION_KEY, storageKey: STORAGE_KEY, keyId: 'test-k1' }),
    store
  };
}

function enrollVectors(slug: string) {
  const src = new SyntheticCaptureSource(demoSeed(slug), { size: 128 });
  return src.captureEnrollmentFrames().map((f) => extractFromGray(f));
}

/** Realistic probe: PROBE_FRAMES_REQUIRED frames averaged, like the POS scan screen. */
function probeVector(slug: string) {
  const src = new SyntheticCaptureSource(demoSeed(slug), { size: 128 });
  return combineVectors(src.captureProbeFrames().map((f) => extractFromGray(f).vector));
}

/** Device-side enrollment code for a slug (what would go over the wire). */
function enrollmentCode(slug: string) {
  return buildEnrollmentCode(
    enrollVectors(slug).map((f) => f.vector),
    PROTECTION_KEY
  );
}

/** Device-side probe code bits. */
function probeBits(slug: string): Uint8Array {
  return protectVector(probeVector(slug), PROTECTION_KEY);
}

const OK_QUALITY = { score: 0.9, usable: true, brightness: 0.5, contrast: 0.8, sharpness: 0.5, hints: ['ok'] as QualityHint[] };

describe('extractor', () => {
  it('is deterministic for identical pixels', () => {
    const img = renderSyntheticPalm(demoSeed('aya'), { stream: 0 });
    const a = extractFromGray(img);
    const b = extractFromGray(img);
    expect(a.vector.f.every((v, i) => v === b.vector.f[i])).toBe(true);
    expect(a.quality.usable).toBe(b.quality.usable);
  });

  it('reports usable quality for healthy synthetic frames', () => {
    const q = extractFromGray(renderSyntheticPalm(demoSeed('aya'), {})).quality;
    expect(q.usable).toBe(true);
    expect(q.hints).toContain('ok');
  });
});

describe('separation and stability of the SIMULATED pipeline', () => {
  const slugs = Array.from({ length: 24 }, (_, i) => `person-${i}`);

  it('same identity across capture variation stays above threshold', () => {
    for (const slug of ['aya', 'omar', 'nour']) {
      const enrolled = combineVectors(enrollVectors(slug).map((f) => f.vector));
      const eb = protectVector(enrolled, PROTECTION_KEY);
      for (let k = 0; k < 3; k++) {
        const pb = protectVector(probeVector(slug), PROTECTION_KEY);
        const sim = 1 - hammingDistance(eb, pb) / 1024;
        expect(sim, `${slug} probe ${k} similarity ${sim}`).toBeGreaterThan(MATCH_THRESHOLD);
      }
    }
  });

  it('different identities stay out of the match band', () => {
    // Calibrated on the synthetic population (docs/BIOMETRICS.md): impostor
    // template similarity has p95 ~= 0.66; rare lookalike pairs can exceed the
    // grey floor but must never reach the match band — such pairs would resolve
    // to a grey-zone rejection or an ambiguity, both of which refuse settlement.
    const sims: number[] = [];
    const codes = new Map<string, Uint8Array>();
    for (const slug of slugs) {
      const frames = enrollVectors(slug);
      codes.set(slug, protectVector(combineVectors(frames.map((f) => f.vector)), PROTECTION_KEY));
    }
    const list = [...codes.entries()];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        sims.push(1 - hammingDistance(list[i]![1], list[j]![1]) / 1024);
      }
    }
    sims.sort((a, b) => a - b);
    const p95 = sims[Math.floor(sims.length * 0.95)]!;
    expect(p95, `inter-class p95 was ${p95}`).toBeLessThan(MATCH_GREY_FLOOR);
    const maxInter = sims[sims.length - 1]!;
    expect(maxInter, `max inter-class similarity was ${maxInter}`).toBeLessThan(MATCH_THRESHOLD);
  });

  it('bit statistics look sane (roughly balanced codes)', () => {
    const code = protectVector(enrollVectors('aya')[0]!.vector, PROTECTION_KEY);
    let ones = 0;
    for (const b of unpackBits(code)) ones += b;
    expect(ones / 1024).toBeGreaterThan(0.35);
    expect(ones / 1024).toBeLessThan(0.65);
  });
});

describe('template protection', () => {
  it('pack/unpack roundtrips bits', () => {
    const bits = new Uint8Array(1024);
    bits[0] = 1;
    bits[1023] = 1;
    bits[513] = 1;
    const packed = packBits(bits);
    expect(packed.length).toBe(128);
    const out = unpackBits(packed);
    expect(Array.from(out)).toEqual(Array.from(bits));
  });

  it('encodeCode produces exactly TEMPLATE_BITS/8 base64 bytes', () => {
    const b64 = encodeCode(packBits(new Uint8Array(1024)));
    expect(Buffer.from(b64, 'base64').length).toBe(128);
  });

  it('AES-GCM seal/open roundtrip with AAD binding', async () => {
    const data = packBits(new Uint8Array(1024).fill(1));
    const sealed = await sealBits(data, STORAGE_KEY, 'customer:c1:t1');
    sealed.keyId = 'k1';
    const opened = await openSealed(sealed, STORAGE_KEY, 'customer:c1:t1');
    expect(hammingDistance(opened, data)).toBe(0);
  });

  it('rejects tampered ciphertext or wrong AAD', async () => {
    const data = packBits(new Uint8Array(1024));
    const sealed = await sealBits(data, STORAGE_KEY, 'customer:c1:t1');
    sealed.keyId = 'k1';
    const tampered = new Uint8Array(sealed.ciphertext);
    tampered[20]! ^= 0xff;
    await expect(openSealed({ ...sealed, ciphertext: tampered }, STORAGE_KEY, 'customer:c1:t1')).rejects.toBeInstanceOf(IntegrityError);
    await expect(openSealed(sealed, STORAGE_KEY, 'customer:c2:t1')).rejects.toBeInstanceOf(IntegrityError);
  });

  it('different protection keys produce different protected codes', () => {
    const v = enrollVectors('aya')[0]!.vector;
    const otherKey = new Uint8Array(32).fill(9);
    const a = protectVector(v, PROTECTION_KEY);
    const b = protectVector(v, otherKey);
    expect(hammingDistance(a, b) / 1024).toBeGreaterThan(0.2);
  });

  it('HKDF purpose separation: the two runtime subkeys are independent', async () => {
    const { protectionKey, storageKey } = await deriveRuntimeKeys(new Uint8Array(32).fill(42));
    expect(protectionKey.length).toBe(32);
    expect(storageKey.length).toBe(32);
    expect(hammingDistance(protectionKey, storageKey) / 256).toBeGreaterThan(0.2);
    // Derivation is deterministic.
    const again = await deriveRuntimeKeys(new Uint8Array(32).fill(42));
    expect(Buffer.from(again.protectionKey).equals(Buffer.from(protectionKey))).toBe(true);
    // A different master yields different subkeys.
    const other = await deriveRuntimeKeys(new Uint8Array(32).fill(43));
    expect(hammingDistance(other.protectionKey, protectionKey) / 256).toBeGreaterThan(0.2);
  });

  it('the device-visible protection key CANNOT unseal stored templates', async () => {
    const code = packBits(new Uint8Array(1024).fill(1));
    const sealed = await sealBits(code, STORAGE_KEY, 'customer:c1:t1');
    await expect(openSealed(sealed, PROTECTION_KEY, 'customer:c1:t1')).rejects.toBeInstanceOf(IntegrityError);
  });
});

describe('matcher decision bands and ambiguity', () => {
  it('identical codes match; distant codes reject', () => {
    const a = packBits(new Uint8Array(1024).fill(1));
    const b = packBits(new Uint8Array(1024));
    expect(bestMatch(a, [{ templateId: 't', subjectId: 's', bits: a }]).decision).toBe('match');
    expect(bestMatch(a, [{ templateId: 't', subjectId: 's', bits: b }]).decision).toBe('no_match');
  });

  it('flags ambiguous when two subjects are near-equal above threshold', () => {
    const base = packBits(new Uint8Array(1024).fill(1));
    const nearTwin = base.slice();
    // flip 12 bits -> similarity 1 - 12/1024 ≈ 0.9883, |diff| to 1.0 is 0.0117 <= 0.02
    for (let i = 0; i < 12; i++) nearTwin[i >> 3]! ^= 1 << (i & 7);
    const res = bestMatch(base, [
      { templateId: 't1', subjectId: 'alice', bits: base },
      { templateId: 't2', subjectId: 'bob', bits: nearTwin }
    ]);
    expect(res.decision).toBe('ambiguous');
    expect(res.subjectId).toBeNull();
  });
});

describe('BiometricService end-to-end over device-protected codes (in-memory)', () => {
  it('enrolls then identifies the right customer', async () => {
    const { service } = makeService();
    const built = enrollmentCode('aya');
    const { templateId, consistencyScore } = await service.enrollPalm({
      subjectType: 'customer',
      subjectId: 'c-aya',
      code: decodeBits(built.code.bits),
      quality: OK_QUALITY,
      captureSource: 'synthetic',
      consistencyScore: built.consistencyScore
    });
    expect(templateId).toBeTruthy();
    expect(consistencyScore).toBeGreaterThanOrEqual(ENROLL_CONSISTENCY_FLOOR);

    const id = await service.identifyPalm(probeBits('aya'));
    expect(id.decision).toBe('match');
    expect(id.subjectId).toBe('c-aya');
  });

  it('rejects strangers', async () => {
    const { service } = makeService();
    const built = enrollmentCode('aya');
    await service.enrollPalm({
      subjectType: 'customer',
      subjectId: 'c-aya',
      code: decodeBits(built.code.bits),
      quality: OK_QUALITY,
      captureSource: 'synthetic',
      consistencyScore: built.consistencyScore
    });
    const id = await service.identifyPalm(probeBits('stranger-xyz'));
    expect(id.decision).toBe('no_match');
    expect(id.subjectId).toBeNull();
  });

  it('refuses wrong-length codes before any crypto or storage work', async () => {
    const { service, store } = makeService();
    await expect(
      service.enrollPalm({
        subjectType: 'customer',
        subjectId: 'c-x',
        code: new Uint8Array(64), // half length
        quality: OK_QUALITY,
        captureSource: 'synthetic',
        consistencyScore: 0.9
      })
    ).rejects.toThrow(/128 bytes|1024 bits/);
    await expect(service.identifyPalm(new Uint8Array(127))).rejects.toThrow();
    expect((await store.listActive('customer')).length).toBe(0);
  });

  it('refuses enrollments whose attested consistency is below the floor', async () => {
    const { service, store } = makeService();
    await expect(
      service.enrollPalm({
        subjectType: 'customer',
        subjectId: 'c-y',
        code: probeBits('aya'),
        quality: OK_QUALITY,
        captureSource: 'synthetic',
        consistencyScore: ENROLL_CONSISTENCY_FLOOR - 0.01
      })
    ).rejects.toThrow(/inconsistent/);
    expect((await store.listActive('customer')).length).toBe(0);
  });

  it('re-enrollment supersedes and deletion revokes', async () => {
    const { service, store } = makeService();
    for (let round = 0; round < 2; round++) {
      const built = enrollmentCode('aya');
      await service.enrollPalm({
        subjectType: 'customer',
        subjectId: 'c-1',
        code: decodeBits(built.code.bits),
        quality: OK_QUALITY,
        captureSource: 'synthetic',
        consistencyScore: built.consistencyScore
      });
    }
    const active = await store.listActive('customer');
    expect(active.length).toBe(1);

    await service.deleteTemplate(active[0]!.templateId);
    const afterDelete = await store.listActive('customer');
    expect(afterDelete.length).toBe(0);
  });

  it('verifyPalm does 1:1 against the subject only', async () => {
    const { service } = makeService();
    const built = enrollmentCode('omar');
    await service.enrollPalm({
      subjectType: 'customer',
      subjectId: 'c-omar',
      code: decodeBits(built.code.bits),
      quality: OK_QUALITY,
      captureSource: 'synthetic',
      consistencyScore: built.consistencyScore
    });
    const ok = await service.verifyPalm(probeBits('omar'), { subjectType: 'customer', subjectId: 'c-omar' });
    expect(ok.decision).toBe('match');

    const bad = await service.verifyPalm(probeBits('aya'), { subjectType: 'customer', subjectId: 'c-omar' });
    expect(bad.decision).toBe('no_match');
  });

  it('templates are SEALED with the storage key — protection-key holders cannot read them', async () => {
    const { service, store } = makeService();
    const built = enrollmentCode('aya');
    const { templateId } = await service.enrollPalm({
      subjectType: 'customer',
      subjectId: 'c-enc',
      code: decodeBits(built.code.bits),
      quality: OK_QUALITY,
      captureSource: 'synthetic',
      consistencyScore: built.consistencyScore
    });
    const row = await store.getById(templateId);
    expect(row).not.toBeNull();
    // A holder of ONLY the device-visible protection key must fail to open it.
    await expect(openSealed(row!.sealed, PROTECTION_KEY, `customer:c-enc:${templateId}`)).rejects.toBeInstanceOf(IntegrityError);
    // The server's storage key opens it back to the exact enrolled code.
    const opened = await openSealed(row!.sealed, STORAGE_KEY, `customer:c-enc:${templateId}`);
    expect(hammingDistance(opened, decodeBits(built.code.bits))).toBe(0);
  });
});

// --- helpers -------------------------------------------------------------

/** base64 wire code -> packed bits. */
function decodeBits(b64: string): Uint8Array {
  const bin = Buffer.from(b64, 'base64');
  return new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength).slice();
}
