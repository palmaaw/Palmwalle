import { newId } from '@palma/shared';
import { nowIso, PalmaDatabase } from '../database.js';
import type { OwnerType, WalletAccountRow } from '../rows.js';

const COLS =
  'id, owner_type AS ownerType, owner_id AS ownerId, kind, currency, ' +
  'balance_piasters AS balancePiasters, status, created_at AS createdAt, updated_at AS updatedAt';

export class AccountRepo {
  constructor(private readonly db: PalmaDatabase) {}

  createForOwner(a: { ownerId: string; ownerType: OwnerType; kind?: string }): WalletAccountRow {
    const ts = nowIso();
    const id = newId();
    this.db
      .stmt(
        `INSERT INTO wallet_accounts (id, owner_type, owner_id, kind, currency, balance_piasters, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'EGP', 0, 'active', ?, ?)`
      )
      .run(id, a.ownerType, a.ownerId, a.kind ?? 'primary', ts, ts);
    return this.getById(id)!;
  }

  /** Idempotent creation — safe to call on every registration/seed path. */
  ensureForOwner(a: { ownerId: string; ownerType: OwnerType; kind?: string }): WalletAccountRow {
    const existing = this.getByOwner(a.ownerType, a.ownerId, a.kind);
    return existing ?? this.createForOwner(a);
  }

  getById(id: string): WalletAccountRow | null {
    return (this.db.stmt(`SELECT ${COLS} FROM wallet_accounts WHERE id = ?`).get(id) ?? null) as WalletAccountRow | null;
  }

  getByOwner(ownerType: OwnerType, ownerId: string, kind = 'primary'): WalletAccountRow | null {
    return (this.db
      .stmt(`SELECT ${COLS} FROM wallet_accounts WHERE owner_type = ? AND owner_id = ? AND kind = ?`)
      .get(ownerType, ownerId, kind) ?? null) as WalletAccountRow | null;
  }

  listByOwner(ownerType: OwnerType, ownerId: string): WalletAccountRow[] {
    return this.db
      .stmt(`SELECT ${COLS} FROM wallet_accounts WHERE owner_type = ? AND owner_id = ? ORDER BY kind`)
      .all(ownerType, ownerId) as unknown as WalletAccountRow[];
  }

  /** Current materialized balance; throws if the account does not exist. */
  balanceOf(accountId: string): number {
    const row = this.getById(accountId);
    if (!row) throw new Error(`wallet account not found: ${accountId}`);
    return row.balancePiasters;
  }
}
