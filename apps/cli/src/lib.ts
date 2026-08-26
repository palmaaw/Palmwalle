/**
 * Shared CLI harness: ON-DEVICE code builders (identical pipeline to the
 * frontends — fuse frames, project into a one-way code locally) and a small
 * typed HTTP client for the e2e/smoke runs.
 *
 * The demo identities below are THE cross-app contract: seed, customer PWA,
 * merchant POS and tests all derive palms from the same demoSeed() slugs.
 */

import {
  ENROLL_FRAMES_REQUIRED,
  PROBE_FRAMES_REQUIRED
} from '@palmwallet/shared';
import type { PalmCodeDTO, QualityReportDTO } from '@palmwallet/shared';
import {
  SyntheticCaptureSource,
  base64ToBytes,
  buildEnrollmentCode,
  buildProbeCode,
  combineVectors,
  cosine,
  demoSeed,
  extractFromGray
} from '@palmwallet/biometrics';
import type { DescriptorVector } from '@palmwallet/biometrics';

export const DEMO_QUALITY: QualityReportDTO = {
  score: 0.92,
  usable: true,
  brightness: 0.5,
  contrast: 0.9,
  sharpness: 0.9,
  hints: ['ok']
};

/** Raw enrollment frame vectors for a demo slug (never leaves this process). */
export function enrollmentFrames(slug: string): DescriptorVector[] {
  const src = new SyntheticCaptureSource(demoSeed(slug), { size: 128 });
  const vectors = src.captureEnrollmentFrames().map((f) => extractFromGray(f).vector);
  if (vectors.length !== ENROLL_FRAMES_REQUIRED) throw new Error('capture source frame count drifted');
  return vectors;
}

/** Raw probe frame vectors as a POS scan would produce. */
export function probeFrames(slug: string): DescriptorVector[] {
  const src = new SyntheticCaptureSource(demoSeed(slug), { size: 128 });
  const vectors = src.captureProbeFrames().map((f) => extractFromGray(f).vector);
  if (vectors.length !== PROBE_FRAMES_REQUIRED) throw new Error('capture source frame count drifted');
  return vectors;
}

/**
 * Full wire-shape enrollment body per EnrollPalmSchema: frames fused + protected
 * LOCALLY with the protection subkey (same flow as a real capture device).
 */
export function enrollBody(
  slug: string,
  protectionKey: Uint8Array
): { code: PalmCodeDTO; quality: QualityReportDTO; consistencyScore: number; capture: { source: 'synthetic'; frames: number } } {
  const built = buildEnrollmentCode(enrollmentFrames(slug), protectionKey);
  return {
    code: built.code,
    quality: DEMO_QUALITY,
    consistencyScore: built.consistencyScore,
    capture: { source: 'synthetic', frames: ENROLL_FRAMES_REQUIRED }
  };
}

/** Full wire-shape probe body: {code, quality} per PalmProbeSchema. */
export function probeBody(
  slug: string,
  protectionKey: Uint8Array
): { code: PalmCodeDTO; quality: QualityReportDTO } {
  return { code: buildProbeCode(probeFrames(slug), protectionKey), quality: DEMO_QUALITY };
}

/** Back-compat alias used by older call sites. */
export function probe(slug: string, protectionKey: Uint8Array): { code: PalmCodeDTO; quality: QualityReportDTO } {
  return probeBody(slug, protectionKey);
}

/** Pull the device-visible protection subkey out of a booted context (tests/seed). */
export function protectionKeyOf(ctx: { biometrics: { protectionKeyB64: string } }): Uint8Array {
  return base64ToBytes(ctx.biometrics.protectionKeyB64);
}

/** Min pairwise cosine among vectors — mirrors client.ts attestation math. */
export function consistencyOf(vectors: DescriptorVector[]): number {
  let c = 1;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) c = Math.min(c, cosine(vectors[i]!, vectors[j]!));
  }
  return Math.round(c * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Minimal fetch wrapper over the {ok,data}/{ok,error} envelope.
// ---------------------------------------------------------------------------

export interface ApiResponse {
  status: number;
  ok: boolean;
  data: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  raw: unknown;
}

export async function call(
  base: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  opts: { token?: string; body?: unknown; setupToken?: string; devToken?: string } = {}
): Promise<ApiResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.setupToken) headers['x-setup-token'] = opts.setupToken;
  if (opts.devToken) headers['x-dev-token'] = opts.devToken;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  const raw: unknown = await res.json().catch(() => null);
  const envelope = raw as { ok?: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } } | null;
  return {
    status: res.status,
    ok: Boolean(envelope?.ok),
    data: envelope?.data ?? null,
    error: envelope?.error ?? null,
    raw
  };
}

export function iso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

/** Nil-prefixed uuid sentinel → SIMULATED provider outage (see providers/registry.ts). */
export function failingRequestId(): string {
  return '00000000-0000-4000-8000-' + crypto.randomUUID().slice(24);
}

// ---------------------------------------------------------------------------
// Embedded server harness (real HTTP over loopback, ephemeral port).
// ---------------------------------------------------------------------------

import { buildApp, buildContext, loadConfig } from '@palmwallet/api';
import type { AppContext } from '@palmwallet/api';

export interface BootedServer {
  base: string;
  ctx: AppContext;
  close(): Promise<void>;
}

/** Boot the REAL API app on an ephemeral port against the given database. */
export async function bootServer(databasePath: string): Promise<BootedServer> {
  const config = { ...loadConfig(), databasePath, host: '127.0.0.1', port: 0, logLevel: 'error' as const };
  const ctx = await buildContext(config);
  const app = buildApp(ctx);
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('server did not bind');
  return {
    base: `http://127.0.0.1:${addr.port}`,
    ctx,
    close: async () => {
      await app.close();
      ctx.db.close();
    }
  };
}
