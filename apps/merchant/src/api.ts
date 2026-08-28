/**
 * Merchant POS API client. Same envelope conventions as the customer app.
 */

const BASE = '/api/v1';
const TOKEN_KEY = 'palm-wallet.pos.token';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(token: string | null): void {
  if (token === null) localStorage.removeItem(TOKEN_KEY);
  else localStorage.setItem(TOKEN_KEY, token);
}

async function req<T>(method: 'GET' | 'POST', path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
  const headers: Record<string, string> = { ...extraHeaders };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError('NETWORK', 'Cannot reach Palm Wallet — check your connection', 0);
  }

  const envelope = (await res.json().catch(() => null)) as
    | { ok: true; data: T }
    | { ok: false; error: { code: string; message: string } }
    | null;

  if (envelope && envelope.ok) return envelope.data;
  const err = envelope && !envelope.ok ? envelope.error : { code: 'INTERNAL', message: 'Unexpected response' };
  throw new ApiError(err.code, err.message, res.status);
}

export interface MerchantDTO {
  id: string;
  name: string;
  code: string;
}

export interface WalletDTO {
  accountId: string;
  balancePiasters: number;
  currency: string;
  formatted?: string;
}

export interface TransactionDTO {
  id: string;
  ref: string;
  type: 'deposit' | 'payment' | 'refund';
  status: string;
  /** Legacy field is optional; current API uses signedAmountPiasters. */
  amountPiasters?: number;
  signedAmountPiasters?: number;
  counterparty: { displayName: string; maskedPhone: string } | null;
  parentRef: string | null;
  createdAt: string;
  settledAt?: string | null;
}

export interface MatchInfo {
  outcome: string;
  /** Coarse band — the API never returns precise similarity scores here. */
  similarityBand?: 'high' | 'grey' | 'low';
  threshold: number;
}

export type AuthorizeResult =
  | {
      kind: 'completed';
      ref: string;
      amountPiasters: number;
      customerName: string;
      maskedPhone: string;
      customerBalanceFormatted: string;
    }
  | { kind: 'rejected'; code: string; message: string; match?: MatchInfo };

/** One-step scan & pay. Biometric rejects arrive as HTTP-200 `rejected`. */
async function authorize(amountPiasters: number, probe: unknown): Promise<AuthorizeResult> {
  const body = { requestId: crypto.randomUUID(), timestamp: new Date().toISOString(), amountPiasters, probe };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${getToken()}`
  };
  const res = await fetch(`${BASE}/payments/authorize`, { method: 'POST', headers, body: JSON.stringify(body) });
  const envelope = (await res.json()) as
    | { ok: true; data: Record<string, unknown> & { status: string } }
    | { ok: false; error: { code: string; message: string } };

  if (envelope.ok && envelope.data.status === 'completed') {
    const d = envelope.data as unknown as {
      transaction: { ref: string; amountPiasters: number };
      customer: { displayName: string; maskedPhone: string };
      wallet: { formatted: string };
    };
    return {
      kind: 'completed',
      ref: d.transaction.ref,
      amountPiasters: d.transaction.amountPiasters,
      customerName: d.customer.displayName,
      maskedPhone: d.customer.maskedPhone,
      customerBalanceFormatted: d.wallet.formatted
    };
  }
  if (envelope.ok && envelope.data.status === 'rejected') {
    const d = envelope.data as unknown as { code: string; message: string; match?: MatchInfo };
    return { kind: 'rejected', code: d.code, message: d.message, match: d.match };
  }
  const e = envelope as { ok: false; error: { code: string; message: string } };
  throw new ApiError(e.error.code, e.error.message, res.status);
}

export const api = {
  /** Dev bootstrap — guarded server-side by X-Setup-Token (demo only). */
  registerMerchant: (setupToken: string, name: string, code: string, phone: string, password: string) =>
    req<{ accessToken: string; merchant: MerchantDTO }>(
      'POST',
      '/merchants/register',
      { name, code, phone, password },
      {
        'x-setup-token': setupToken
      }
    ),

  login: (identifier: string, password: string) =>
    req<{ accessToken: string; merchant: MerchantDTO }>('POST', '/auth/merchant/login', { identifier, password }),

  me: () => req<{ merchant: MerchantDTO }>('GET', '/merchants/me'),

  /** Authenticated fetch of the device-visible protection subkey. */
  protectionKey: () =>
    req<{ algoId: string; version: number; bits: number; protectionKeyB64: string }>('GET', '/biometrics/protection-key'),

  wallet: () => req<{ wallet: WalletDTO }>('GET', '/merchants/me/wallet'),

  transactions: (cursor?: string, limit = 20) =>
    req<{ items: TransactionDTO[]; nextCursor: string | null }>(
      'GET',
      `/merchants/me/transactions?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`
    ),

  refund: (ref: string, reason?: string) =>
    req<{ status: string }>('POST', `/transactions/${ref}/refund`, {
      requestId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      reason
    }),

  authorize,
  setToken
};
