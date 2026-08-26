/**
 * Palm lifecycle endpoints.
 *
 * DEVICE-SIDE PROTECTION: every payload arrives as an ALREADY-PROTECTED
 * 1024-bit code (the capture device fused + projected its frames locally with
 * the protection subkey). The server never receives feature descriptors, has no
 * code path that decodes them, and reports status/bands — never template bytes,
 * and on the payment path never even a precise score.
 */

import { ApiError, ENROLL_CONSISTENCY_FLOOR } from '@palmwallet/shared';
import { DeletePalmSchema, EnrollPalmRequestSchema, PalmSelfTestSchema } from '@palmwallet/shared';
import { decodeCode } from '@palmwallet/biometrics';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../container.js';
import { parseBody } from '../lib.js';
import { verifyPassword } from '../security/passwordHash.js';
import { palmEnrolled } from './customerAuth.js';

export function palmRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Protection subkey for AUTHENTICATED capture clients only. Prototype-grade
   *  custody (production readers hold keys in secure hardware) — but gating it
   *  behind a session keeps anonymous callers from minting well-formed probes. */
  app.get('/api/v1/biometrics/protection-key', { onRequest: [ctx.auth.requireAnySession] }, async () => {
    return {
      ok: true as const,
      data: {
        algoId: ctx.biometrics.algo.id,
        version: 1,
        bits: ctx.biometrics.algo.bits,
        protectionKeyB64: ctx.biometrics.protectionKeyB64
      }
    };
  });

  /** Enroll or RE-enroll (previous active template is revoked atomically). */
  app.post('/api/v1/customers/me/palm/enroll', { onRequest: [ctx.auth.requireCustomer] }, async (req) => {
    const body = parseBody(req, EnrollPalmRequestSchema);
    const me = req.customer!;

    if (!body.quality.usable) {
      throw new ApiError('BIOMETRIC_LOW_QUALITY', 'Capture quality too low to enroll — retake in better light');
    }
    if (body.consistencyScore < ENROLL_CONSISTENCY_FLOOR) {
      throw new ApiError('BIOMETRIC_LOW_QUALITY', 'Enrollment frames were inconsistent — recapture');
    }

    let code;
    try {
      code = decodeCode(body.code);
    } catch (err) {
      throw new ApiError('BIOMETRIC_UNSUPPORTED_ALGO', `Unsupported palm code: ${(err as Error).message}`);
    }

    const captureSource = body.capture.source;
    try {
      const result = await ctx.biometrics.enrollPalm({
        subjectType: 'customer',
        subjectId: me.id,
        code,
        quality: body.quality,
        captureSource,
        consistencyScore: body.consistencyScore
      });
      ctx.repos.audit.append({
        actorType: 'customer',
        actorId: me.id,
        event: 'palm.enrolled',
        subjectType: 'customer',
        subjectId: me.id,
        data: {
          templateId: result.templateId,
          qualityScore: body.quality.score,
          source: captureSource,
          frames: body.capture.frames,
          consistencyScore: body.consistencyScore // device-attested
        }
      });
      return {
        ok: true as const,
        data: { enrolled: true, templateId: result.templateId, consistencyScore: result.consistencyScore }
      };
    } catch (err) {
      const msg = (err as Error).message ?? '';
      if (msg.includes('quality')) throw new ApiError('BIOMETRIC_LOW_QUALITY', msg);
      if (msg.includes('inconsistent')) throw new ApiError('BIOMETRIC_LOW_QUALITY', 'Enrollment frames were inconsistent — recapture');
      if (msg.includes('Unsupported') || msg.includes('code')) throw new ApiError('BIOMETRIC_UNSUPPORTED_ALGO', msg);
      throw err;
    }
  });

  app.get('/api/v1/customers/me/palm/status', { onRequest: [ctx.auth.requireCustomer] }, async (req) => {
    const me = req.customer!;
    const rows = await ctx.templates.getBySubject('customer', me.id);
    const active = rows[0];
    return {
      ok: true as const,
      data: {
        enrolled: Boolean(active),
        templateId: active?.templateId ?? null,
        // algo metadata only — never template material or key bytes
        algo: ctx.biometrics.algo
      }
    };
  });

  /** Live 1:1 self-test against the caller's own active template. */
  app.post('/api/v1/customers/me/palm/self-test', { onRequest: [ctx.auth.requireCustomer] }, async (req) => {
    const body = parseBody(req, PalmSelfTestSchema);
    const me = req.customer!;
    if (!ctx.probeThrottle.take(`self-test:${me.id}`)) {
      throw new ApiError('RATE_LIMITED', `Too many self-tests — retry in ${ctx.probeThrottle.retryAfterSeconds(`self-test:${me.id}`)}s`);
    }
    let code;
    try {
      code = decodeCode(body.probe.code);
    } catch (err) {
      throw new ApiError('BIOMETRIC_UNSUPPORTED_ALGO', `Unsupported palm code: ${(err as Error).message}`);
    }
    const match = await ctx.biometrics.verifyPalm(code, { subjectType: 'customer', subjectId: me.id });
    ctx.repos.audit.append({
      actorType: 'customer',
      actorId: me.id,
      event: 'palm.self_test',
      subjectType: 'customer',
      subjectId: me.id,
      outcome: match.decision === 'match' ? 'ok' : 'rejected',
      // score/threshold/outcome ONLY — no features leave the pipeline boundary.
      data: { decision: match.decision, score: Math.round(match.similarity * 10000) / 10000 }
    });
    return {
      ok: true as const,
      data: {
        decision: match.decision,
        greyZone: match.greyZone,
        // The customer verifying their OWN palm 1:1 may see their own score; the
        // 1:N payment path returns bands only (see paymentService).
        score: Math.round(match.similarity * 10000) / 10000,
        threshold: match.threshold,
        algoId: ctx.biometrics.algo.id
      }
    };
  });

  /** Delete (soft-revoke) the palm — requires password re-authentication. */
  app.delete('/api/v1/customers/me/palm', { onRequest: [ctx.auth.requireCustomer] }, async (req) => {
    const body = parseBody(req, DeletePalmSchema);
    const me = req.customer!;
    if (!verifyPassword(body.password, me.passwordHash)) {
      throw new ApiError('AUTH_INVALID_CREDENTIALS', 'Wrong password');
    }
    const rows = await ctx.templates.getBySubject('customer', me.id);
    for (const r of rows) await ctx.biometrics.deleteTemplate(r.templateId);
    ctx.repos.audit.append({
      actorType: 'customer',
      actorId: me.id,
      event: 'palm.deleted',
      subjectType: 'customer',
      subjectId: me.id,
      data: { revoked: rows.length }
    });
    return { ok: true as const, data: { deleted: rows.length > 0, enrolled: false } };
  });
}
