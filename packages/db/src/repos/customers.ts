import { nowIso, PalmaDatabase } from '../database.js';
import type { CustomerRow, MerchantRow } from '../rows.js';

const COLS = 'id, phone, name, pin_hash AS pinHash, status, created_at AS createdAt, updated_at AS updatedAt';

export class CustomerRepo {
  constructor(private readonly db: PalmaDatabase) {}

  insert(c: { id: string; phone: string; name: string; pinHash: string }): void {
    const ts = nowIso();
    this.db
      .stmt(
        `INSERT INTO customers (id, phone, name, pin_hash, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', ?, ?)`
      )
      .run(c.id, c.phone, c.name, c.pinHash, ts, ts);
  }

  getById(id: string): CustomerRow | null {
    return (this.db.stmt(`SELECT ${COLS} FROM customers WHERE id = ?`).get(id) ?? null) as CustomerRow | null;
  }

  getByPhone(phone: string): CustomerRow | null {
    return (this.db.stmt(`SELECT ${COLS} FROM customers WHERE phone = ?`).get(phone) ?? null) as CustomerRow | null;
  }

  setStatus(id: string, status: 'active' | 'disabled'): void {
    this.db.stmt('UPDATE customers SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), id);
  }

  updatePinHash(id: string, pinHash: string): void {
    this.db.stmt('UPDATE customers SET pin_hash = ?, updated_at = ? WHERE id = ?').run(pinHash, nowIso(), id);
  }
}

const M_COLS =
  'id, code, name, phone, pin_hash AS pinHash, status, created_at AS createdAt, updated_at AS updatedAt';

export class MerchantRepo {
  constructor(private readonly db: PalmaDatabase) {}

  insert(m: { id: string; code: string; name: string; phone: string; pinHash: string }): void {
    const ts = nowIso();
    this.db
      .stmt(
        `INSERT INTO merchants (id, code, name, phone, pin_hash, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
      )
      .run(m.id, m.code, m.name, m.phone, m.pinHash, ts, ts);
  }

  getById(id: string): MerchantRow | null {
    return (this.db.stmt(`SELECT ${M_COLS} FROM merchants WHERE id = ?`).get(id) ?? null) as MerchantRow | null;
  }

  getByCode(code: string): MerchantRow | null {
    return (this.db.stmt(`SELECT ${M_COLS} FROM merchants WHERE code = ?`).get(code) ?? null) as MerchantRow | null;
  }

  getByPhone(phone: string): MerchantRow | null {
    return (this.db.stmt(`SELECT ${M_COLS} FROM merchants WHERE phone = ?`).get(phone) ?? null) as MerchantRow | null;
  }

  setStatus(id: string, status: 'active' | 'disabled'): void {
    this.db.stmt('UPDATE merchants SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), id);
  }
}
