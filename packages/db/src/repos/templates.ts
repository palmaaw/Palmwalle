/**
 * SQLite TemplateStore — persists SEALED biometric templates only.
 *
 * What lives here: AES-256-GCM ciphertext of protected (projected + binarized)
 * template bits, bound to subject identity via AAD. What can NEVER live here:
 * raw palm photographs, plaintext descriptors, or any reversible representation
 * of a palm. Revoked rows are kept for audit history; a partial UNIQUE index
 * guarantees at most one ACTIVE template per subject.
 */

import type { SealedTemplate, TemplateStore, TemplateStoreRow } from '@palmwallet/biometrics';
import { nowIso, PalmWalletDatabase } from '../database.js';
import type { TemplateRow } from '../rows.js';

const COLS =
  'id, subject_type AS subjectType, subject_id AS subjectId, algo_id AS algoId, ' +
  'algo_version AS algoVersion, descriptor_dim AS descriptorDim, bits, key_id AS keyId, ' +
  'ciphertext, quality_score AS qualityScore, capture_source AS captureSource, ' +
  'status, enrolled_at AS enrolledAt, revoked_at AS revokedAt';

function toStoreRow(r: TemplateRow): TemplateStoreRow {
  return {
    templateId: r.id,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    sealed: { ciphertext: r.ciphertext, keyId: r.keyId } satisfies SealedTemplate
  };
}

interface InsertArgs {
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
}

export class SqliteTemplateStore implements TemplateStore {
  constructor(private readonly db: PalmWalletDatabase) {}

  async insert(row: InsertArgs): Promise<void> {
    this.db
      .stmt(
        `INSERT INTO biometric_templates
           (id, subject_type, subject_id, algo_id, algo_version, descriptor_dim, bits,
            key_id, ciphertext, quality_score, capture_source, status, enrolled_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)`
      )
      .run(
        row.templateId,
        row.subjectType,
        row.subjectId,
        row.algoId,
        row.algoVersion,
        row.descriptorDim,
        row.bits,
        row.keyId,
        row.sealed.ciphertext,
        row.qualityScore,
        row.captureSource,
        nowIso()
      );
  }

  async listActive(subjectType?: string): Promise<TemplateStoreRow[]> {
    const rows = (
      subjectType
        ? this.db
            .stmt(`SELECT ${COLS} FROM biometric_templates WHERE status = 'active' AND subject_type = ?`)
            .all(subjectType)
        : this.db.stmt(`SELECT ${COLS} FROM biometric_templates WHERE status = 'active'`).all()
    ) as unknown as TemplateRow[];
    return rows.map(toStoreRow);
  }

  async getBySubject(subjectType: string, subjectId: string): Promise<TemplateStoreRow[]> {
    const rows = this.db
      .stmt(
        `SELECT ${COLS} FROM biometric_templates
         WHERE status = 'active' AND subject_type = ? AND subject_id = ?`
      )
      .all(subjectType, subjectId) as unknown as TemplateRow[];
    return rows.map(toStoreRow);
  }

  async getById(templateId: string): Promise<TemplateStoreRow | null> {
    const row = this.db
      .stmt(`SELECT ${COLS} FROM biometric_templates WHERE id = ?`)
      .get(templateId) as TemplateRow | undefined;
    return row ? toStoreRow(row) : null;
  }

  async revokeActive(subjectType: string, subjectId: string, exceptId?: string): Promise<number> {
    if (exceptId) {
      const res = this.db
        .stmt(
          `UPDATE biometric_templates SET status = 'revoked', revoked_at = ?
           WHERE subject_type = ? AND subject_id = ? AND status = 'active' AND id != ?`
        )
        .run(nowIso(), subjectType, subjectId, exceptId);
      return Number(res.changes);
    }
    const res = this.db
      .stmt(
        `UPDATE biometric_templates SET status = 'revoked', revoked_at = ?
         WHERE subject_type = ? AND subject_id = ? AND status = 'active'`
      )
      .run(nowIso(), subjectType, subjectId);
    return Number(res.changes);
  }

  async revokeById(templateId: string): Promise<void> {
    this.db
      .stmt(
        `UPDATE biometric_templates SET status = 'revoked', revoked_at = ?
         WHERE id = ? AND status = 'active'`
      )
      .run(nowIso(), templateId);
  }
}
