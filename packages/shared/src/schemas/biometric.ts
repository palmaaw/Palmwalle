import { z } from 'zod';
import { ALGO_ID, TEMPLATE_BITS } from '../constants.js';
import { CaptureSourceSchema } from './common.js';

/**
 * Wire format for a PROTECTED palm code: 1024 one-way bits produced ON THE
 * CAPTURE DEVICE (random projection + sign binarization of the fused feature
 * vector). Raw palm images NEVER travel to the server and are NEVER persisted —
 * and neither are reversible feature descriptors anymore. The server accepts
 * nothing else; see docs/BIOMETRICS.md for the threat model.
 */
export const PalmCodeSchema = z.object({
  algoId: z.literal(ALGO_ID),
  version: z.number().int().positive(),
  /** base64 of exactly TEMPLATE_BITS/8 packed bytes (byte-length checked at decode). */
  bits: z.base64()
});
export type PalmCodeDTO = z.infer<typeof PalmCodeSchema>;

export const QualityHintSchema = z.enum([
  'ok',
  'too_dark',
  'too_bright',
  'low_contrast',
  'too_blurry',
  'center_palm',
  'hold_steady'
]);
export type QualityHint = z.infer<typeof QualityHintSchema>;

export const QualityReportSchema = z.object({
  score: z.number().min(0).max(1),
  usable: z.boolean(),
  brightness: z.number().min(0).max(1),
  contrast: z.number().min(0).max(1),
  sharpness: z.number().min(0).max(1),
  hints: z.array(QualityHintSchema).max(7)
});
export type QualityReportDTO = z.infer<typeof QualityReportSchema>;

/** Protected code plus capture metadata — what verification endpoints accept. */
export const PalmProbeSchema = z.object({
  code: PalmCodeSchema,
  quality: QualityReportSchema
});
export type PalmProbeDTO = z.infer<typeof PalmProbeSchema>;

export const EnrollPalmSchema = z.object({
  code: PalmCodeSchema,
  quality: QualityReportSchema,
  /** Device-attested min pairwise cosine among enrollment frames; server enforces a floor. */
  consistencyScore: z.number().min(0).max(1),
  capture: z.object({
    source: CaptureSourceSchema,
    frames: z.number().int().min(1).max(10)
  })
});
export type EnrollPalmDTO = z.infer<typeof EnrollPalmSchema>;
