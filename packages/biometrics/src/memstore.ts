/**
 * In-memory TemplateStore for unit tests and pure in-memory operation.
 * Mirrors the sqlite adapter's semantics (partial-unique "one active per subject").
 */

import type {
  SealedTemplate,
  TemplateStore,
  TemplateStoreRow
} from './types.js';

interface Row extends TemplateStoreRow {
  subjectType: string;
  algoId: string;
  algoVersion: string;
  descriptorDim: number;
  bitsCount: number;
  keyId: string;
  qualityScore: number;
  captureSource: 'camera' | 'synthetic';
  status: 'active' | 'revoked';
}

export class InMemoryTemplateStore implements TemplateStore {
  private rows = new Map<string, Row>();
  private order: string[] = [];

  async insert(r: {
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
  }): Promise<void> {
    const dupActive = [...this.rows.values()].some(
      (x) => x.status === 'active' && x.subjectType === r.subjectType && x.subjectId === r.subjectId
    );
    if (dupActive) throw new Error('subject already has an active template');
    this.rows.set(r.templateId, {
      templateId: r.templateId,
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      sealed: r.sealed,
      algoId: r.algoId,
      algoVersion: r.algoVersion,
      descriptorDim: r.descriptorDim,
      bitsCount: r.bits,
      keyId: r.keyId,
      qualityScore: r.qualityScore,
      captureSource: r.captureSource,
      status: 'active'
    });
    this.order.push(r.templateId);
  }

  async listActive(subjectType?: string): Promise<TemplateStoreRow[]> {
    return [...this.order]
      .map((id) => this.rows.get(id)!)
      .filter((r) => r && r.status === 'active' && (!subjectType || r.subjectType === subjectType))
      .map(toRow);
  }

  async getBySubject(subjectType: string, subjectId: string): Promise<TemplateStoreRow[]> {
    return (await this.listActive(subjectType)).filter((r) => r.subjectId === subjectId);
  }

  async getById(templateId: string): Promise<TemplateStoreRow | null> {
    const r = this.rows.get(templateId);
    return r ? toRow(r) : null;
  }

  async revokeActive(subjectType: string, subjectId: string, exceptId?: string): Promise<number> {
    let n = 0;
    for (const r of this.rows.values()) {
      if (
        r.status === 'active' &&
        r.subjectType === subjectType &&
        r.subjectId === subjectId &&
        r.templateId !== exceptId
      ) {
        r.status = 'revoked';
        n++;
      }
    }
    return n;
  }

  async revokeById(templateId: string): Promise<void> {
    const r = this.rows.get(templateId);
    if (r) r.status = 'revoked';
  }

  get size(): number {
    return this.rows.size;
  }
}

function toRow(r: Row): TemplateStoreRow {
  return {
    templateId: r.templateId,
    subjectType: r.subjectType,
    subjectId: r.subjectId,
    sealed: r.sealed
  };
}
